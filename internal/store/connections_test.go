package store_test

import (
	"bytes"
	"reflect"
	"testing"

	"github.com/minifish-org/pith-post/internal/domain"
	"github.com/minifish-org/pith-post/internal/testutil"
)

func TestModelMigrationPreservesIdentityAndLegacyDeliveryHistory(t *testing.T) {
	s := testutil.Store(t)
	c := testutil.Agent(t, s, "migration")
	original := domain.Secrets{Password: "synthetic-password", AccessToken: "synthetic-token", ModelKey: "synthetic-model-key", PickleKey: bytes.Repeat([]byte{7}, 32)}
	if err := s.PutSecrets(c.ID, original); err != nil {
		t.Fatal(err)
	}
	before, _ := s.State(c.ID)
	if _, err := s.Enqueue(c.ID, "proactive:legacy", "Original task"); err != nil {
		t.Fatal(err)
	}
	run, _ := s.Next(c.ID)
	if err := s.Complete(run, []domain.Content{{Kind: "text", Text: "Discarded reply"}, {Kind: "text", Text: "Delivered reply"}}); err != nil {
		t.Fatal(err)
	}
	pending, _ := s.Pending(c.ID)
	for _, out := range pending {
		if err := s.Sent(out.ID); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.Audit(c.ID, "discard-delivery", pending[0].ID+": Legacy administrator decision"); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if err := s.Init(); err != nil {
			t.Fatal(err)
		}
	}
	connections, err := s.Connections()
	if err != nil || len(connections) != 1 {
		t.Fatalf("migration was not idempotent: %v", err)
	}
	after, _ := s.State(c.ID)
	secrets, _ := s.Secrets(c.ID)
	if !reflect.DeepEqual(before, after) || !reflect.DeepEqual(original, secrets) {
		t.Fatal("migration changed identity or credentials")
	}
	config, key, err := s.GenerationConfig(c.ID)
	if err != nil || key != original.ModelKey || config.Connection != connections[0].ID {
		t.Fatal("shared model was not restored")
	}
	config.Connection = ""
	if !reflect.DeepEqual(c, config) {
		t.Fatal("migration changed assistant configuration")
	}
	_, history, err := s.History(c.ID)
	if err != nil || len(history) != 2 {
		t.Fatal("history lost")
	}
	for _, out := range history {
		if out.Discarded != (out.ID == pending[0].ID) {
			t.Fatal("legacy discarded delivery reported as delivered")
		}
	}
	newKey := "replacement-synthetic-key"
	connection := connections[0]
	connection.Model = "replacement-model"
	if err := s.SaveConnection(connection, &newKey); err != nil {
		t.Fatal(err)
	}
	config, key, err = s.GenerationConfig(c.ID)
	if err != nil || config.Model != connection.Model || key != newKey {
		t.Fatal("next turn did not receive matching shared model and key")
	}
	secrets, _ = s.Secrets(c.ID)
	if !reflect.DeepEqual(original, secrets) {
		t.Fatal("model edit altered Matrix credentials")
	}
}
