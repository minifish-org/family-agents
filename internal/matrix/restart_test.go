package matrix

import (
	"context"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/minifish-org/pith-post/internal/domain"
	"github.com/minifish-org/pith-post/internal/testutil"
	"maunium.net/go/mautrix/event"
	"maunium.net/go/mautrix/id"
)

func TestRestartContinuityWarningDoesNotBecomeAMembershipHold(t *testing.T) {
	for _, hold := range []string{domain.TimelineGapHold, "Owner-only encrypted membership could not be verified"} {
		t.Run(hold, func(t *testing.T) {
			s := testutil.Store(t)
			c := testutil.Agent(t, s, "restart-gap")
			before, _ := s.State(c.ID)
			_ = s.PutSecrets(c.ID, domain.Secrets{AccessToken: "offline-restart-token"})
			_ = s.UpdateState(c.ID, func(st *domain.State) error { st.Paused = hold; return nil })
			owner := c.Owner
			server := &matrixServer{c: c, device: before.Device, events: map[string][]byte{}, syncLimited: true, syncEvent: &event.Event{ID: "$joined", Type: event.StateMember, StateKey: &owner, Sender: id.UserID(c.Owner), RoomID: id.RoomID(before.Room), Content: event.Content{Parsed: &event.MemberEventContent{Membership: event.MembershipJoin}}}}
			httpServer := httptest.NewServer(server)
			defer httpServer.Close()
			c.Homeserver = httpServer.URL
			opened, err := (Factory{Store: s}).Open(context.Background(), c)
			if err != nil {
				t.Fatal(err)
			}
			defer opened.Close()
			tr := opened.(*Transport)
			ctx, cancel := context.WithTimeout(context.Background(), time.Second*3)
			defer cancel()
			_ = tr.Run(ctx, func(domain.Inbound) error { return nil }, func() error { return nil })
			after, _ := s.State(c.ID)
			if hold == domain.TimelineGapHold {
				if after.Paused != "" || after.SyncWarning == "" {
					t.Fatal("ordinary restart froze a verified private chat")
				}
			} else if after.Paused != hold {
				t.Fatal("real membership hold was silently cleared")
			}
			if after.Device != before.Device || after.Room != before.Room || after.Generation != before.Generation {
				t.Fatal("restart recovery changed crypto identity")
			}
			_ = tr.Run(ctx, func(domain.Inbound) error { return nil }, func() error { return nil })
			server.mu.Lock()
			creates := server.filterCreates
			server.mu.Unlock()
			if creates != 1 {
				t.Fatalf("restart recreated the all-room sync filter: %d", creates)
			}
		})
	}
}
