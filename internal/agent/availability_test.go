package agent

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/minifish-org/pith-post/internal/domain"
	"github.com/minifish-org/pith-post/internal/testutil"
)

func TestInitialInvitationIsNotASecurityHold(t *testing.T) {
	s := testutil.Store(t)
	c := testutil.Agent(t, s, "invitation")
	transport := newTransport(c)
	transport.snapshot.Members[0].Membership = "invite"
	if err := s.UpdateState(c.ID, func(st *domain.State) error { st.AwaitingOwner = true; return nil }); err != nil {
		t.Fatal(err)
	}
	m := New(s, &fakeModel{}, nil)
	defer m.Close()
	if err := m.check(context.Background(), c, transport, false); !errors.Is(err, domain.ErrAwaitingOwner) {
		t.Fatal(err)
	}
	st, _ := s.State(c.ID)
	if st.Paused != "" || st.SecurityEpoch != 0 {
		t.Fatal("normal invitation became a security hold")
	}
	transport.snapshot.Members = append(transport.snapshot.Members, domain.Member{MXID: "@third:example.test", Membership: "invite"})
	if err := m.check(context.Background(), c, transport, false); !errors.Is(err, domain.ErrPaused) {
		t.Fatal("third-party invite was not blocked")
	}
	transport.snapshot.Members = transport.snapshot.Members[:2]
	transport.snapshot.Members[0].Membership = "join"
	if err := m.check(context.Background(), c, transport, false); !errors.Is(err, domain.ErrPaused) {
		t.Fatal("later safe membership silently cleared a hold")
	}
}
func TestDisableDrainsOneTurnAndLeavesNextQueued(t *testing.T) {
	s := testutil.Store(t)
	c := testutil.Agent(t, s, "drain")
	transport := newTransport(c)
	model := &fakeModel{started: make(chan struct{}, 1), release: make(chan struct{}), outputs: []domain.Content{{Kind: "text", Text: "done"}}}
	m := New(s, model, func(context.Context, domain.Config) (domain.Transport, error) { return transport, nil })
	m.Interval = time.Millisecond * 10
	defer m.Close()
	if err := m.SetEnabled(c.ID, true); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Trigger(c.ID, "first", "First"); err != nil {
		t.Fatal(err)
	}
	select {
	case <-model.started:
	case <-time.After(3 * time.Second):
		t.Fatal("first task did not start")
	}
	if _, err := m.Trigger(c.ID, "second", "Second"); err != nil {
		t.Fatal(err)
	}
	if err := m.SetEnabled(c.ID, false); err != nil {
		t.Fatal(err)
	}
	if !m.Running(c.ID) || !m.Draining(c.ID) {
		t.Fatal("disable interrupted the current turn")
	}
	if _, err := m.Trigger(c.ID, "third", "Third"); !errors.Is(err, domain.ErrStopped) {
		t.Fatal("draining accepted a new manual task")
	}
	close(model.release)
	deadline := time.Now().Add(3 * time.Second)
	for m.Running(c.ID) && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if m.Running(c.ID) {
		t.Fatal("assistant did not finish draining")
	}
	counts, err := s.Counts(c.ID)
	if err != nil || counts.Queued != 1 || counts.Interrupted != 0 || counts.Running != 0 {
		t.Fatalf("unexpected queue: %+v %v", counts, err)
	}
	c, err = s.Config(c.ID)
	if err != nil || c.AutoStart {
		t.Fatal("disabled preference was not persisted")
	}
	if transport.count() != 1 {
		t.Fatal("current reply not delivered exactly once")
	}
}

func TestStopAndApplyCancelsTurnBeforeRemovingConfiguration(t *testing.T) {
	s := testutil.Store(t)
	c := testutil.Agent(t, s, "remove-running")
	transport := newTransport(c)
	model := &fakeModel{started: make(chan struct{}, 1), release: make(chan struct{}), outputs: []domain.Content{{Kind: "text", Text: "must not send"}}}
	m := New(s, model, func(context.Context, domain.Config) (domain.Transport, error) { return transport, nil })
	m.Interval = 10 * time.Millisecond
	defer m.Close()
	if err := m.SetEnabled(c.ID, true); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Trigger(c.ID, "first", "First"); err != nil {
		t.Fatal(err)
	}
	select {
	case <-model.started:
	case <-time.After(3 * time.Second):
		t.Fatal("turn did not start")
	}
	called := false
	if err := m.StopAndApply(c.ID, func() error {
		called = true
		if m.Running(c.ID) {
			t.Error("removal callback ran before worker stopped")
		}
		r, err := s.App.FindRecordById("agents", c.ID)
		if err != nil {
			return err
		}
		return s.App.Delete(r)
	}); err != nil {
		t.Fatal(err)
	}
	if !called || m.Running(c.ID) || transport.count() != 0 {
		t.Fatal("removal allowed background work or delivery")
	}
	if err := m.Start(c.ID); err == nil {
		t.Fatal("removed configuration restarted")
	}
	runs, _, err := s.History(c.ID)
	if err != nil || len(runs) != 1 || runs[0].Status != "interrupted" {
		t.Fatal("interrupted task archive was lost")
	}
}
