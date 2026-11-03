package agent

import (
	"context"
	"github.com/minifish-org/pith-post/internal/domain"
	"github.com/minifish-org/pith-post/internal/testutil"
	"sync/atomic"
	"testing"
	"time"
)

type chatRequestTransport struct {
	*fakeTransport
	request chan struct{}
}

func (t *chatRequestTransport) Run(ctx context.Context, _ func(domain.Inbound) error, _ func() error) error {
	select {
	case <-ctx.Done():
		return nil
	case <-t.request:
		return domain.ErrChatRequested
	}
}
func TestOwnerChatRequestReopensSameAssistant(t *testing.T) {
	s := testutil.Store(t)
	c := testutil.Agent(t, s, "reconnect")
	before, _ := s.State(c.ID)
	first := &chatRequestTransport{newTransport(c), make(chan struct{})}
	second := newTransport(c)
	var opens atomic.Int32
	m := New(s, &fakeModel{}, func(context.Context, domain.Config) (domain.Transport, error) {
		if opens.Add(1) == 1 {
			return first, nil
		}
		return second, nil
	})
	defer m.Close()
	m.Interval = 10 * time.Millisecond
	if err := m.SetEnabled(c.ID, true); err != nil {
		t.Fatal(err)
	}
	close(first.request)
	deadline := time.Now().Add(3 * time.Second)
	for opens.Load() < 2 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if opens.Load() != 2 || !m.Running(c.ID) {
		t.Fatal("private chat request did not reopen the assistant")
	}
	after, _ := s.State(c.ID)
	if after.Device != before.Device || after.Generation != before.Generation || after.Conversation != before.Conversation {
		t.Fatal("reconnect changed identity/history")
	}
	if err := m.Stop(c.ID); err != nil {
		t.Fatal(err)
	}
	if m.Running(c.ID) {
		t.Fatal("stopped assistant restarted itself")
	}
}
