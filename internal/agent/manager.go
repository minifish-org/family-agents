// Package agent serializes each agent independently and owns the durable delivery pipeline.
package agent

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"time"

	"github.com/minifish-org/pith-post/internal/domain"
	"github.com/minifish-org/pith-post/internal/store"
)

type worker struct {
	cancel    context.CancelFunc
	done      chan struct{}
	wake      chan struct{}
	transport domain.Transport
	ctx       context.Context
}
type slot struct {
	mu     sync.Mutex
	worker *worker
}
type Manager struct {
	Store    *store.Store
	Model    domain.Model
	Open     domain.Factory
	Reset    func(context.Context, domain.Config, string) error
	Interval time.Duration
	ctx      context.Context
	cancel   context.CancelFunc
	mu       sync.Mutex
	slots    map[string]*slot
}

func New(s *store.Store, model domain.Model, open domain.Factory) *Manager {
	ctx, cancel := context.WithCancel(context.Background())
	return &Manager{Store: s, Model: model, Open: open, Interval: 5 * time.Second, ctx: ctx, cancel: cancel, slots: map[string]*slot{}}
}
func (m *Manager) slot(id string) *slot {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.slots[id] == nil {
		m.slots[id] = &slot{}
	}
	return m.slots[id]
}
func alive(w *worker) bool {
	if w == nil {
		return false
	}
	select {
	case <-w.done:
		return false
	default:
		return true
	}
}
func (m *Manager) Running(id string) bool {
	s := m.slot(id)
	s.mu.Lock()
	defer s.mu.Unlock()
	return alive(s.worker)
}
func (m *Manager) Start(id string) error {
	s := m.slot(id)
	s.mu.Lock()
	defer s.mu.Unlock()
	return m.startLocked(id, s)
}
func (m *Manager) startLocked(id string, s *slot) error {
	if alive(s.worker) {
		return nil
	}
	if m.ctx.Err() != nil {
		return domain.ErrStopped
	}
	c, err := m.Store.Config(id)
	if err != nil {
		return err
	}
	if err = m.Store.RecoverAgent(id); err != nil {
		return err
	}
	ctx, cancel := context.WithCancel(m.ctx)
	initCtx, initCancel := context.WithTimeout(ctx, 90*time.Second)
	transport, err := m.Open(initCtx, c)
	initCancel()
	if err != nil {
		// An administrator's documented recovery decision is required. A decryption error never enters this path.
		state, stateErr := m.Store.State(id)
		if errors.Is(err, domain.ErrCryptoRecovery) && stateErr == nil && c.AutoReset && state.RecoveryImpossible != "" && state.ResetCount == 0 && m.Reset != nil {
			resetCtx, resetCancel := context.WithTimeout(ctx, 90*time.Second)
			err = m.Reset(resetCtx, c, state.RecoveryImpossible)
			if err == nil {
				transport, err = m.Open(resetCtx, c)
			}
			resetCancel()
		}
	}
	if err != nil {
		cancel()
		_ = m.Store.UpdateState(id, func(s *domain.State) error {
			s.LastError = "Startup failed; check credentials, room binding, and crypto recovery"
			return nil
		})
		return errors.New("agent startup failed; check credentials, room binding, and crypto recovery")
	}
	w := &worker{ctx: ctx, cancel: cancel, done: make(chan struct{}), wake: make(chan struct{}, 1), transport: transport}
	s.worker = w
	go m.run(c, w)
	return nil
}
func (m *Manager) Stop(id string) error {
	s := m.slot(id)
	s.mu.Lock()
	defer s.mu.Unlock()
	m.stopLocked(s)
	return nil
}
func (m *Manager) stopLocked(s *slot) {
	if s.worker != nil {
		s.worker.cancel()
		<-s.worker.done
		s.worker = nil
	}
}
func (m *Manager) Restart(id string) error {
	s := m.slot(id)
	s.mu.Lock()
	defer s.mu.Unlock()
	m.stopLocked(s)
	return m.startLocked(id, s)
}
func (m *Manager) Close() {
	m.cancel()
	m.mu.Lock()
	slots := make([]*slot, 0, len(m.slots))
	for _, s := range m.slots {
		slots = append(slots, s)
	}
	m.mu.Unlock()
	var wg sync.WaitGroup
	for _, s := range slots {
		wg.Add(1)
		go func() { defer wg.Done(); s.mu.Lock(); defer s.mu.Unlock(); m.stopLocked(s) }()
	}
	wg.Wait()
}
func (m *Manager) WithStopped(id string, fn func() error) error {
	s := m.slot(id)
	s.mu.Lock()
	defer s.mu.Unlock()
	if alive(s.worker) {
		return errors.New("stop the agent before this operation")
	}
	return fn()
}
func (m *Manager) NewConversation(id string) error {
	return m.WithStopped(id, func() error {
		unsettled, err := m.Store.Unsettled(id)
		if err != nil {
			return err
		}
		if unsettled {
			return errors.New("resolve pending deliveries and runs before starting a new conversation")
		}
		return m.Store.UpdateState(id, func(s *domain.State) error { s.Conversation++; return nil })
	})
}
func (m *Manager) pause(id string) error {
	return m.Store.UpdateState(id, func(s *domain.State) error {
		s.Paused = "Owner-only encrypted membership could not be verified"
		s.SecurityEpoch++
		return nil
	})
}
func (m *Manager) check(ctx context.Context, c domain.Config, t domain.Transport, ignorePause bool) error {
	state, err := m.Store.State(c.ID)
	if err != nil {
		return err
	}
	if state.Paused != "" && !ignorePause {
		return domain.ErrPaused
	}
	snapshot, err := t.Snapshot(ctx)
	if err == nil {
		err = domain.OwnerOnly(c, state.Room, snapshot)
	}
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if e := m.pause(c.ID); e != nil {
			return e
		}
		return domain.ErrPaused
	}
	return nil
}
func (m *Manager) Resume(id string) error {
	s := m.slot(id)
	s.mu.Lock()
	defer s.mu.Unlock()
	if !alive(s.worker) {
		return domain.ErrStopped
	}
	c, err := m.Store.Config(id)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(s.worker.ctx, 30*time.Second)
	defer cancel()
	before, err := m.Store.State(id)
	if err != nil {
		return err
	}
	if err = m.check(ctx, c, s.worker.transport, true); err != nil {
		return err
	}
	if err = m.Store.UpdateState(id, func(s *domain.State) error {
		if s.SecurityEpoch != before.SecurityEpoch {
			return domain.ErrPaused
		}
		s.Paused = ""
		s.LastError = ""
		return nil
	}); err != nil {
		return err
	}
	wake(s.worker)
	return nil
}
func wake(w *worker) {
	select {
	case w.wake <- struct{}{}:
	default:
	}
}
func (m *Manager) Trigger(id, key, prompt string) (string, error) {
	if len(key) < 1 || len(key) > 128 || strings.TrimSpace(prompt) == "" || len(prompt) > domain.MaxText {
		return "", errors.New("an idempotency key and a prompt of 1 to 24000 bytes are required")
	}
	s := m.slot(id)
	s.mu.Lock()
	defer s.mu.Unlock()
	if !alive(s.worker) {
		return "", domain.ErrStopped
	}
	c, err := m.Store.Config(id)
	if err != nil {
		return "", err
	}
	ctx, cancel := context.WithTimeout(s.worker.ctx, 30*time.Second)
	defer cancel()
	if err = m.check(ctx, c, s.worker.transport, false); err != nil {
		return "", err
	}
	run, err := m.Store.Enqueue(id, "proactive:"+key, prompt)
	if err == nil {
		wake(s.worker)
	}
	return run, err
}
func (m *Manager) admit(ctx context.Context, c domain.Config, w *worker, in domain.Inbound) error {
	state, err := m.Store.State(c.ID)
	if err != nil {
		return err
	}
	if !in.Decrypted || in.EventID == "" || !strings.HasPrefix(in.EventID, "$") || in.Room != state.Room || in.Sender != c.Owner || in.Sender == c.Bot || strings.TrimSpace(in.Text) == "" || len(in.Text) > domain.MaxText {
		return nil
	}
	if err = m.check(ctx, c, w.transport, false); errors.Is(err, domain.ErrPaused) {
		return nil
	} else if err != nil {
		return err
	}
	_, err = m.Store.Enqueue(c.ID, in.EventID, in.Text)
	if err == nil {
		wake(w)
	}
	return err
}
func (m *Manager) run(c domain.Config, w *worker) {
	defer close(w.done)
	defer w.transport.Close()
	syncDone := make(chan struct{})
	go func() {
		defer close(syncDone)
		err := w.transport.Run(w.ctx, func(in domain.Inbound) error { return m.admit(w.ctx, c, w, in) }, func() error {
			err := m.check(w.ctx, c, w.transport, true)
			if errors.Is(err, domain.ErrPaused) {
				return nil
			}
			return err
		})
		if err != nil && w.ctx.Err() == nil {
			_ = m.Store.UpdateState(c.ID, func(s *domain.State) error { s.LastError = "Matrix sync stopped; restart the agent"; return nil })
		}
		w.cancel()
	}()
	defer func() { w.cancel(); <-syncDone }()
	ticker := time.NewTicker(m.Interval)
	defer ticker.Stop()
	for {
		if w.ctx.Err() != nil {
			return
		}
		err := m.step(w.ctx, c, w.transport)
		if err != nil && !errors.Is(err, domain.ErrPaused) && !errors.Is(err, domain.ErrReview) && w.ctx.Err() == nil {
			// Never log SDK/provider/HTTP errors, which may contain request bodies or credentials.
			_ = m.Store.UpdateState(c.ID, func(s *domain.State) error {
				s.LastError = "Execution or delivery failed; inspect history and retry or review"
				return nil
			})
		}
		select {
		case <-w.ctx.Done():
			return
		case <-w.wake:
		case <-ticker.C:
		}
	}
}
func (m *Manager) step(ctx context.Context, c domain.Config, t domain.Transport) error {
	if err := m.deliver(ctx, c, t); err != nil {
		return err
	}
	review, err := m.Store.HasBlockedRun(c.ID)
	if err != nil {
		return err
	}
	if review {
		return domain.ErrReview
	}
	r, err := m.Store.Next(c.ID)
	if err != nil || r == nil {
		return err
	}
	if err = m.check(ctx, c, t, false); err != nil {
		return err
	}
	// Fresh configuration on every turn applies prompt/model edits without a Matrix login.
	current, err := m.Store.Config(c.ID)
	if err != nil {
		return err
	}
	state, err := m.Store.State(c.ID)
	if err != nil {
		return err
	}
	workspace, session, _, err := m.Store.Paths(c.ID, state)
	if err != nil {
		return err
	}
	secrets, err := m.Store.Secrets(c.ID)
	if err != nil {
		return err
	}
	if err = m.Store.SetRun(r.ID, "running", ""); err != nil {
		return err
	}
	turnCtx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	contents, err := m.Model.Generate(turnCtx, current, session, workspace, r.Input, secrets.ModelKey)
	cancel()
	if err != nil {
		if e := m.Store.SetRun(r.ID, "interrupted", "Execution did not complete; administrator review required before replay"); e != nil {
			return e
		}
		return domain.ErrReview
	}
	if err = m.Store.Complete(r, contents); err != nil {
		_ = m.Store.SetRun(r.ID, "interrupted", "Completion could not be committed; administrator review required")
		return err
	}
	return m.deliver(ctx, c, t)
}
func (m *Manager) deliver(ctx context.Context, c domain.Config, t domain.Transport) error {
	pending, err := m.Store.Pending(c.ID)
	if err != nil {
		return err
	}
	for _, out := range pending {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if err = m.check(ctx, c, t, false); err != nil {
			return err
		}
		wire := out.Wire
		if len(wire) == 0 {
			var content domain.Content
			if err = json.Unmarshal([]byte(out.Content), &content); err != nil {
				return err
			}
			if wire, err = t.Prepare(ctx, content); err != nil {
				return err
			}
			if err = m.Store.Wire(out.ID, wire); err != nil {
				return err
			}
		}
		// Recheck after encryption/uploads or a long task, and on every retry.
		if err = m.check(ctx, c, t, false); err != nil {
			return err
		}
		if err = t.Send(ctx, wire, "pith-post-"+out.ID); err != nil {
			return err
		}
		if err = m.Store.Sent(out.ID); err != nil {
			return err
		}
	}
	return nil
}
