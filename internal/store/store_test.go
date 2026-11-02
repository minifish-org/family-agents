package store_test

import (
	"bytes"
	"encoding/base64"
	"testing"

	"github.com/minifish-org/pith-post/internal/domain"
	"github.com/minifish-org/pith-post/internal/store"
	"github.com/minifish-org/pith-post/internal/testutil"
	"github.com/pocketbase/dbx"
)

func TestSecretsAreEncryptedAndBoundToAgent(t *testing.T) {
	s := testutil.Store(t)
	a := testutil.Agent(t, s, "secret-a")
	b := testutil.Agent(t, s, "secret-b")
	original := domain.Secrets{Password: "test-password-not-real", AccessToken: "test-token-not-real", ModelKey: "test-model-key-not-real", PickleKey: bytes.Repeat([]byte{7}, 32)}
	if err := s.PutSecrets(a.ID, original); err != nil {
		t.Fatal(err)
	}
	var row struct {
		Value []byte `db:"value"`
	}
	if err := s.App.DB().NewQuery("SELECT value FROM post_secrets WHERE agent={:a}").Bind(dbx.Params{"a": a.ID}).One(&row); err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(row.Value, []byte(original.Password)) || bytes.Contains(row.Value, []byte(original.AccessToken)) {
		t.Fatal("secret was stored as plaintext")
	}
	actual, err := s.Secrets(a.ID)
	if err != nil || actual.AccessToken != original.AccessToken {
		t.Fatal("secret round trip failed")
	}
	_, err = s.App.DB().NewQuery("INSERT INTO post_secrets(agent,value) VALUES({:a},{:v})").Bind(dbx.Params{"a": b.ID, "v": row.Value}).Execute()
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.Secrets(b.ID); err == nil {
		t.Fatal("encrypted credentials were transferable between agents")
	}
	wrong, err := store.New(s.App, base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{1}, 32)))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = wrong.Secrets(a.ID); err == nil {
		t.Fatal("wrong master key decrypted credentials")
	}
}
func TestIdentityResetIsExplicitOneShotAndPreservesConversation(t *testing.T) {
	s := testutil.Store(t)
	a := testutil.Agent(t, s, "reset")
	if err := s.PutSecrets(a.ID, domain.Secrets{Password: "test-password", AccessToken: "test-token", PickleKey: bytes.Repeat([]byte{1}, 32)}); err != nil {
		t.Fatal(err)
	}
	if err := s.UpdateState(a.ID, func(st *domain.State) error { st.Conversation = 3; st.CryptoReady = true; return nil }); err != nil {
		t.Fatal(err)
	}
	if err := s.ResetIdentity(a.ID, "NEW_DEVICE", "short"); err == nil {
		t.Fatal("identity reset accepted no meaningful reason")
	}
	if err := s.ResetIdentity(a.ID, "NEW_DEVICE", "Original crypto backup is confirmed unavailable"); err != nil {
		t.Fatal(err)
	}
	st, _ := s.State(a.ID)
	if st.Conversation != 3 || st.Room != "!reset:example.test" || st.Device != "NEW_DEVICE" || st.CryptoReady || st.Generation != 1 || st.ResetCount != 1 {
		t.Fatal("identity reset changed unrelated state or failed to set its loop guard")
	}
	if err := s.ResetIdentity(a.ID, "ANOTHER_DEVICE", "Do not reset for the same recovery failure"); err == nil {
		t.Fatal("identity reset loop was permitted")
	}
	secrets, _ := s.Secrets(a.ID)
	if secrets.AccessToken != "" || len(secrets.PickleKey) != 0 || secrets.Password == "" {
		t.Fatal("replacement identity retained the previous token or lost the login credential")
	}
}
func TestCollectionsAreLockedAndOwnershipIsImmutable(t *testing.T) {
	s := testutil.Store(t)
	a := testutil.Agent(t, s, "locked")
	for _, name := range []string{"owners", "agents"} {
		col, err := s.App.FindCollectionByNameOrId(name)
		if err != nil {
			t.Fatal(err)
		}
		if col.ListRule != nil || col.ViewRule != nil || col.CreateRule != nil || col.UpdateRule != nil || col.DeleteRule != nil {
			t.Fatal("management collection is not superuser-only")
		}
	}
	record, err := s.App.FindRecordById("agents", a.ID)
	if err != nil {
		t.Fatal(err)
	}
	record.Set("bot_mxid", "@replacement:example.test")
	if err = s.App.Save(record); err == nil {
		t.Fatal("agent bot identity was mutable")
	}
}
