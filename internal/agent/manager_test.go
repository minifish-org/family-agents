package agent

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/minifish-org/pith-post/internal/domain"
	"github.com/minifish-org/pith-post/internal/store"
	"github.com/minifish-org/pith-post/internal/testutil"
)

type fakeTransport struct {
	mu            sync.Mutex
	snapshot      domain.Snapshot
	inbound       chan domain.Inbound
	change        chan struct{}
	visible       map[string]string
	attempts      []string
	wire          [][]byte
	failAck       bool
	snapshotError bool
}

func newTransport(c domain.Config) *fakeTransport {
	return &fakeTransport{snapshot: domain.Snapshot{Room: "!" + c.Name + ":example.test", Encrypted: true, Members: []domain.Member{{MXID: c.Owner, Membership: "join"}, {MXID: c.Bot, Membership: "join"}}}, inbound: make(chan domain.Inbound, 50), change: make(chan struct{}, 10), visible: map[string]string{}}
}
func (f *fakeTransport) Snapshot(context.Context) (domain.Snapshot, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.snapshotError {
		return domain.Snapshot{}, errors.New("membership unavailable")
	}
	s := f.snapshot
	s.Members = append([]domain.Member(nil), s.Members...)
	return s, nil
}
func (f *fakeTransport) Prepare(_ context.Context, c domain.Content) ([]byte, error) {
	return json.Marshal(c)
}
func (f *fakeTransport) Send(_ context.Context, wire []byte, txn string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.visible[txn] = string(wire)
	f.attempts = append(f.attempts, txn)
	f.wire = append(f.wire, append([]byte(nil), wire...))
	if f.failAck {
		f.failAck = false
		return errors.New("server accepted delivery but acknowledgement was lost")
	}
	return nil
}
func (f *fakeTransport) Run(ctx context.Context, onEvent func(domain.Inbound) error, onMembership func() error) error {
	for {
		select {
		case <-ctx.Done():
			return nil
		case in := <-f.inbound:
			if err := onEvent(in); err != nil {
				return err
			}
		case <-f.change:
			if err := onMembership(); err != nil {
				return err
			}
		}
	}
}
func (f *fakeTransport) Close() error { return nil }
func (f *fakeTransport) count() int   { f.mu.Lock(); defer f.mu.Unlock(); return len(f.visible) }
func (f *fakeTransport) event(c domain.Config, event, text string) {
	f.inbound <- domain.Inbound{EventID: event, Room: "!" + c.Name + ":example.test", Sender: c.Owner, Text: text, Decrypted: true}
}

type call struct {
	Config                           domain.Config
	Session, Workspace, Input, Prior string
}
type fakeModel struct {
	mu      sync.Mutex
	calls   []call
	started chan struct{}
	release chan struct{}
	outputs []domain.Content
}

func (f *fakeModel) Generate(ctx context.Context, c domain.Config, session, workspace, input, key string) ([]domain.Content, error) {
	prior, _ := os.ReadFile(session)
	f.mu.Lock()
	f.calls = append(f.calls, call{c, session, workspace, input, string(prior)})
	started, release := f.started, f.release
	outputs := f.outputs
	f.mu.Unlock()
	if started != nil {
		select {
		case started <- struct{}{}:
		default:
		}
	}
	if release != nil {
		select {
		case <-release:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	if err := os.WriteFile(session, append(prior, []byte(c.Prompt+" | "+input+"\n")...), 0600); err != nil {
		return nil, err
	}
	if outputs != nil {
		return outputs, nil
	}
	return []domain.Content{{Kind: "text", Text: c.Name + ": " + input}}, nil
}
func (f *fakeModel) count() int { f.mu.Lock(); defer f.mu.Unlock(); return len(f.calls) }
func eventually(t *testing.T, fn func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if fn() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("condition did not become true")
}
func fixture(t *testing.T) (*Manager, *store.Store, domain.Config, *fakeTransport, *fakeModel) {
	t.Helper()
	s := testutil.Store(t)
	c := testutil.Agent(t, s, "first")
	transport := newTransport(c)
	model := &fakeModel{}
	m := New(s, model, func(context.Context, domain.Config) (domain.Transport, error) { return transport, nil })
	m.Interval = 10 * time.Millisecond
	t.Cleanup(m.Close)
	if err := m.Start(c.ID); err != nil {
		t.Fatal(err)
	}
	return m, s, c, transport, model
}

func TestEncryptedOwnerConversationSurvivesAgentRestart(t *testing.T) {
	m, s, c, transport, model := fixture(t)
	transport.event(c, "$one", "Remember the blue bicycle")
	eventually(t, func() bool { return transport.count() == 1 })
	first, _ := s.State(c.ID)
	if err := m.Restart(c.ID); err != nil {
		t.Fatal(err)
	}
	transport.event(c, "$two", "What should you remember?")
	eventually(t, func() bool { return transport.count() == 2 })
	model.mu.Lock()
	defer model.mu.Unlock()
	if len(model.calls) != 2 || !strings.Contains(model.calls[1].Prior, "blue bicycle") {
		t.Fatal("restart did not retain the explicit conversation file")
	}
	second, _ := s.State(c.ID)
	if first.Device != second.Device || first.Conversation != second.Conversation {
		t.Fatal("restart changed the device or conversation")
	}
}
func TestUnauthorizedAndDuplicateEventsNeverCallModel(t *testing.T) {
	_, _, c, transport, model := fixture(t)
	good := domain.Inbound{EventID: "$good", Room: "!first:example.test", Sender: c.Owner, Text: "Hello", Decrypted: true}
	for _, mutate := range []func(*domain.Inbound){func(e *domain.Inbound) { e.Room = "!other:example.test" }, func(e *domain.Inbound) { e.Sender = "@stranger:example.test" }, func(e *domain.Inbound) { e.Sender = c.Bot }, func(e *domain.Inbound) { e.Decrypted = false }} {
		bad := good
		mutate(&bad)
		transport.inbound <- bad
	}
	for range 10 {
		transport.inbound <- good
	}
	eventually(t, func() bool { return transport.count() == 1 })
	time.Sleep(80 * time.Millisecond)
	if model.count() != 1 {
		t.Fatalf("expected one model invocation, got %d", model.count())
	}
}
func TestMembershipChangeDuringTaskBlocksDeliveryAndRetry(t *testing.T) {
	m, s, c, transport, model := fixture(t)
	model.mu.Lock()
	model.started = make(chan struct{}, 1)
	model.release = make(chan struct{})
	started, release := model.started, model.release
	model.mu.Unlock()
	transport.event(c, "$long", "A long-running task")
	<-started
	transport.mu.Lock()
	transport.snapshot.Members = append(transport.snapshot.Members, domain.Member{MXID: "@third:example.test", Membership: "invite"})
	transport.mu.Unlock()
	transport.change <- struct{}{}
	eventually(t, func() bool { state, _ := s.State(c.ID); return state.Paused != "" })
	close(release)
	eventually(t, func() bool { pending, _ := s.Pending(c.ID); return len(pending) == 1 })
	if transport.count() != 0 {
		t.Fatal("task result leaked after an unsafe membership change")
	}
	transport.mu.Lock()
	transport.snapshot.Members = transport.snapshot.Members[:2]
	transport.mu.Unlock()
	time.Sleep(50 * time.Millisecond)
	if transport.count() != 0 {
		t.Fatal("a safe snapshot unexpectedly cleared the pause latch")
	}
	if err := m.Resume(c.ID); err != nil {
		t.Fatal(err)
	}
	eventually(t, func() bool { return transport.count() == 1 })
	if model.count() != 1 {
		t.Fatal("delivery retry executed the model again")
	}
}
func TestMembershipUnavailableAndOwnerLeaveFailClosed(t *testing.T) {
	for _, mode := range []string{"unavailable", "owner-left", "third-joined", "third-invited", "unencrypted"} {
		t.Run(mode, func(t *testing.T) {
			_, s, c, transport, model := fixture(t)
			transport.mu.Lock()
			switch mode {
			case "unavailable":
				transport.snapshotError = true
			case "owner-left":
				transport.snapshot.Members[0].Membership = "leave"
			case "third-joined":
				transport.snapshot.Members = append(transport.snapshot.Members, domain.Member{MXID: "@third:example.test", Membership: "join"})
			case "third-invited":
				transport.snapshot.Members = append(transport.snapshot.Members, domain.Member{MXID: "@third:example.test", Membership: "invite"})
			case "unencrypted":
				transport.snapshot.Encrypted = false
			}
			transport.mu.Unlock()
			transport.event(c, "$bad", "Do not execute")
			eventually(t, func() bool { st, _ := s.State(c.ID); return st.Paused != "" })
			if model.count() != 0 {
				t.Fatal("unsafe membership invoked the model")
			}
		})
	}
}
func TestProactiveImageAndLostAcknowledgementUseOneStableTransaction(t *testing.T) {
	m, _, c, transport, model := fixture(t)
	model.mu.Lock()
	model.outputs = []domain.Content{{Kind: "image", Name: "pixel.png", MIME: "image/png", Data: []byte("test image bytes")}}
	model.mu.Unlock()
	transport.mu.Lock()
	transport.failAck = true
	transport.mu.Unlock()
	id, err := m.Trigger(c.ID, "daily-image", "Prepare an image")
	if err != nil {
		t.Fatal(err)
	}
	again, err := m.Trigger(c.ID, "daily-image", "Prepare an image")
	if err != nil || again != id {
		t.Fatal("idempotent trigger failed")
	}
	eventually(t, func() bool { transport.mu.Lock(); defer transport.mu.Unlock(); return len(transport.attempts) >= 2 })
	transport.mu.Lock()
	defer transport.mu.Unlock()
	if len(transport.visible) != 1 || transport.attempts[0] != transport.attempts[1] || string(transport.wire[0]) != string(transport.wire[1]) {
		t.Fatal("retry did not reuse the persisted event and transaction")
	}
	if model.count() != 1 {
		t.Fatal("proactive retry invoked the model again")
	}
}
func TestTwoAgentsRemainIndependentAndPromptsChangeBetweenTurns(t *testing.T) {
	s := testutil.Store(t)
	a := testutil.Agent(t, s, "alpha")
	b := testutil.Agent(t, s, "beta")
	ta, tb := newTransport(a), newTransport(b)
	model := &fakeModel{}
	m := New(s, model, func(_ context.Context, c domain.Config) (domain.Transport, error) {
		if c.ID == a.ID {
			return ta, nil
		}
		return tb, nil
	})
	m.Interval = 5 * time.Millisecond
	defer m.Close()
	if err := m.Start(a.ID); err != nil {
		t.Fatal(err)
	}
	if err := m.Start(b.ID); err != nil {
		t.Fatal(err)
	}
	ta.event(a, "$a1", "Alpha memory")
	tb.event(b, "$b1", "Beta memory")
	eventually(t, func() bool { return ta.count() == 1 && tb.count() == 1 })
	if err := m.Restart(a.ID); err != nil {
		t.Fatal(err)
	}
	if !m.Running(b.ID) {
		t.Fatal("restarting one agent stopped the other")
	}
	record, err := s.App.FindRecordById("agents", a.ID)
	if err != nil {
		t.Fatal(err)
	}
	record.Set("system_prompt", "Changed between turns")
	if err = s.App.Save(record); err != nil {
		t.Fatal(err)
	}
	ta.event(a, "$a2", "Continue alpha")
	tb.event(b, "$b2", "Continue beta")
	eventually(t, func() bool { return ta.count() == 2 && tb.count() == 2 })
	model.mu.Lock()
	defer model.mu.Unlock()
	var ca, cb call
	for _, call := range model.calls {
		if call.Input == "Continue alpha" {
			ca = call
		}
		if call.Input == "Continue beta" {
			cb = call
		}
	}
	if ca.Config.Prompt != "Changed between turns" || cb.Config.Prompt == ca.Config.Prompt || ca.Workspace == cb.Workspace || ca.Session == cb.Session || strings.Contains(ca.Prior, "Beta memory") || strings.Contains(cb.Prior, "Alpha memory") {
		t.Fatal("agent prompt, workspace, or history was not isolated")
	}
	sa, _ := s.State(a.ID)
	sb, _ := s.State(b.ID)
	_, _, cryptoA, _ := s.Paths(a.ID, sa)
	_, _, cryptoB, _ := s.Paths(b.ID, sb)
	if cryptoA == cryptoB {
		t.Fatal("crypto stores are shared")
	}
}
func TestInterruptedRunRequiresReviewAndIsNeverImplicitlyReplayed(t *testing.T) {
	m, s, c, transport, model := fixture(t)
	model.mu.Lock()
	model.started = make(chan struct{}, 1)
	model.release = make(chan struct{})
	started := model.started
	model.mu.Unlock()
	transport.event(c, "$interrupt", "Do not replay automatically")
	<-started
	if err := m.Stop(c.ID); err != nil {
		t.Fatal(err)
	}
	if err := m.Start(c.ID); err != nil {
		t.Fatal(err)
	}
	time.Sleep(70 * time.Millisecond)
	review, err := s.HasReview(c.ID)
	if err != nil || !review {
		t.Fatal("interrupted execution was not marked for review")
	}
	if model.count() != 1 {
		t.Fatal("interrupted execution was implicitly replayed")
	}
	if err := m.Stop(c.ID); err != nil {
		t.Fatal(err)
	}
	if err := s.Review(c.ID, store.StableID(c.ID, "$interrupt"), false); err != nil {
		t.Fatal(err)
	}
	if err := m.NewConversation(c.ID); err != nil {
		t.Fatal(err)
	}
	state, _ := s.State(c.ID)
	if state.Conversation != 1 || state.Device != "DEVICE_first" {
		t.Fatal("new conversation changed the Matrix identity")
	}
}
func TestCrashMarksRunningRowsInterruptedAndKeepsCompletedOutbox(t *testing.T) {
	s := testutil.Store(t)
	c := testutil.Agent(t, s, "crash")
	running, err := s.Enqueue(c.ID, "$running", "Interrupted")
	if err != nil {
		t.Fatal(err)
	}
	if err = s.SetRun(running, "running", ""); err != nil {
		t.Fatal(err)
	}
	completed, err := s.Enqueue(c.ID, "$completed", "Completed")
	if err != nil {
		t.Fatal(err)
	}
	if err = s.Complete(&store.Run{ID: completed, Agent: c.ID}, []domain.Content{{Kind: "text", Text: "Durable reply"}}); err != nil {
		t.Fatal(err)
	}
	if err = s.Init(); err != nil {
		t.Fatal(err)
	}
	review, err := s.HasReview(c.ID)
	if err != nil || !review {
		t.Fatal("crash recovery did not require review")
	}
	pending, err := s.Pending(c.ID)
	if err != nil || len(pending) != 1 {
		t.Fatal("crash recovery lost a completed reply")
	}
}
