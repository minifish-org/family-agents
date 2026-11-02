package agent

import (
	"context"
	"errors"
	"testing"

	"github.com/minifish-org/pith-post/internal/domain"
	"github.com/minifish-org/pith-post/internal/testutil"
)

func TestAutomaticResetRequiresCryptoFailurePermissionAndConfirmedImpossibleRecovery(t *testing.T) {
	for _, scenario := range []struct {
		name               string
		enabled, confirmed bool
		failure            error
		want               int
	}{
		{"permission-disabled", false, true, domain.ErrCryptoRecovery, 0},
		{"recovery-unconfirmed", true, false, domain.ErrCryptoRecovery, 0},
		{"ordinary-network-failure", true, true, errors.New("network unavailable"), 0},
		{"confirmed-crypto-loss", true, true, domain.ErrCryptoRecovery, 1},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			s := testutil.Store(t)
			c := testutil.Agent(t, s, "recovery")
			record, err := s.App.FindRecordById("agents", c.ID)
			if err != nil {
				t.Fatal(err)
			}
			record.Set("auto_reset", scenario.enabled)
			if err = s.App.Save(record); err != nil {
				t.Fatal(err)
			}
			if scenario.confirmed {
				if err = s.UpdateState(c.ID, func(st *domain.State) error {
					st.RecoveryImpossible = "Offline backups checked; original keys are unavailable"
					return nil
				}); err != nil {
					t.Fatal(err)
				}
			}
			resets := 0
			opens := 0
			m := New(s, &fakeModel{}, func(context.Context, domain.Config) (domain.Transport, error) { opens++; return nil, scenario.failure })
			defer m.Close()
			m.Reset = func(context.Context, domain.Config, string) error {
				resets++
				return s.UpdateState(c.ID, func(st *domain.State) error { st.ResetCount++; return nil })
			}
			_ = m.Start(c.ID)
			_ = m.Start(c.ID)
			if resets != scenario.want {
				t.Fatalf("expected %d resets, got %d after %d starts", scenario.want, resets, opens)
			}
		})
	}
}
func TestLostAcknowledgementRetrySurvivesServiceRestartWithoutModelReplay(t *testing.T) {
	s := testutil.Store(t)
	c := testutil.Agent(t, s, "outbox")
	transport := newTransport(c)
	transport.failAck = true
	model := &fakeModel{}
	m := New(s, model, nil)
	defer m.Close()
	if _, err := s.Enqueue(c.ID, "$reply", "Prepare durable content"); err != nil {
		t.Fatal(err)
	}
	if err := m.step(context.Background(), c, transport); err == nil {
		t.Fatal("lost acknowledgement was not simulated")
	}
	if err := s.Init(); err != nil {
		t.Fatal(err)
	}
	restarted := New(s, model, nil)
	defer restarted.Close()
	if err := restarted.step(context.Background(), c, transport); err != nil {
		t.Fatal(err)
	}
	if model.count() != 1 || len(transport.visible) != 1 || len(transport.attempts) != 2 || transport.attempts[0] != transport.attempts[1] || string(transport.wire[0]) != string(transport.wire[1]) {
		t.Fatal("restart did not retain the completed reply and stable transaction")
	}
}
