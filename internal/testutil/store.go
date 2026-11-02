// Package testutil provides isolated, credential-free test fixtures.
package testutil

import (
	"encoding/base64"
	"testing"

	"github.com/minifish-org/pith-post/internal/domain"
	"github.com/minifish-org/pith-post/internal/store"
	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/core"
)

func Key() string { return base64.StdEncoding.EncodeToString(make([]byte, 32)) }
func Store(t testing.TB) *store.Store {
	t.Helper()
	app := pocketbase.NewWithConfig(pocketbase.Config{DefaultDataDir: t.TempDir()})
	store.RegisterValidation(app)
	if err := app.Bootstrap(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = app.ResetBootstrapState() })
	if err := store.EnsureSchema(app); err != nil {
		t.Fatal(err)
	}
	s, err := store.New(app, Key())
	if err != nil {
		t.Fatal(err)
	}
	if err = s.Init(); err != nil {
		t.Fatal(err)
	}
	return s
}
func Agent(t testing.TB, s *store.Store, name string) domain.Config {
	t.Helper()
	owners, err := s.App.FindAllRecords("owners")
	if err != nil {
		t.Fatal(err)
	}
	var owner *core.Record
	if len(owners) == 0 {
		col, err := s.App.FindCollectionByNameOrId("owners")
		if err != nil {
			t.Fatal(err)
		}
		owner = core.NewRecord(col)
		owner.Set("name", "Family owner")
		owner.Set("mxid", "@owner:example.test")
		if err = s.App.Save(owner); err != nil {
			t.Fatal(err)
		}
	} else {
		owner = owners[0]
	}
	col, err := s.App.FindCollectionByNameOrId("agents")
	if err != nil {
		t.Fatal(err)
	}
	record := core.NewRecord(col)
	for k, v := range map[string]any{"name": name, "owner": owner.Id, "bot_mxid": "@" + name + ":example.test", "homeserver": "https://matrix.example.test", "system_prompt": "You are " + name, "model": "test-model", "model_url": "http://127.0.0.1:11434/v1", "model_api": "openai-completions", "context_window": 8192, "max_tokens": 1024} {
		record.Set(k, v)
	}
	if err = s.App.Save(record); err != nil {
		t.Fatal(err)
	}
	c, err := s.Config(record.Id)
	if err != nil {
		t.Fatal(err)
	}
	if err = s.UpdateState(c.ID, func(st *domain.State) error {
		st.Room = "!" + name + ":example.test"
		st.Device = "DEVICE_" + name
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	return c
}
