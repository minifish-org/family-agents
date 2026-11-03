package store_test

import (
	"context"
	"encoding/base64"
	"strings"
	"testing"

	"github.com/minifish-org/pith-post/internal/store"
	"github.com/minifish-org/pith-post/internal/testutil"
	authtypes "github.com/minifish-org/pith/packages/ai/auth/types"
	"github.com/pocketbase/dbx"
)

func TestProviderCredentialsAreEncryptedProviderBoundAndPersistent(t *testing.T) {
	s := testutil.Store(t)
	ctx := context.Background()
	credential := authtypes.NewOAuthCredential("private-provider-refresh", "private-provider-access", 1234)
	_, err := s.ProviderCredentials().Modify(ctx, "openai-codex", func(authtypes.Credential) (authtypes.Credential, error) { return credential, nil }, nil)
	if err != nil {
		t.Fatal(err)
	}
	var raw []byte
	if err = s.App.DB().NewQuery(`SELECT value FROM post_provider_credentials WHERE provider='openai-codex'`).Row(&raw); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), credential.Access) || strings.Contains(string(raw), credential.Refresh) {
		t.Fatal("plaintext provider credential")
	}
	reopened, err := store.New(s.App, testutil.Key())
	if err != nil {
		t.Fatal(err)
	}
	got, err := reopened.ProviderCredentials().Read(ctx, "openai-codex", nil)
	if err != nil || got.(*authtypes.OAuthCredential).Refresh != credential.Refresh {
		t.Fatal("credential did not survive reopen")
	}
	_, _ = s.App.DB().NewQuery(`INSERT INTO post_provider_credentials(provider,value) VALUES('another-provider',{:v})`).Bind(dbx.Params{"v": raw}).Execute()
	if _, err = s.ProviderCredentials().Read(ctx, "another-provider", nil); err == nil {
		t.Fatal("cross-provider credential accepted")
	}
	wrong := make([]byte, 32)
	wrong[0] = 1
	other, err := store.New(s.App, base64.StdEncoding.EncodeToString(wrong))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = other.ProviderCredentials().Read(ctx, "openai-codex", nil); err == nil {
		t.Fatal("wrong master key accepted")
	}
	first, err := s.ProviderDeviceID()
	if err != nil {
		t.Fatal(err)
	}
	second, _ := reopened.ProviderDeviceID()
	if first == "" || first != second {
		t.Fatal("provider installation identity changed")
	}
}
