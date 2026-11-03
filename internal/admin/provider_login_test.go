package admin

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/minifish-org/pith-post/internal/pith"
	"github.com/minifish-org/pith-post/internal/testutil"
	"github.com/minifish-org/pith/packages/ai"
	authtypes "github.com/minifish-org/pith/packages/ai/auth/types"
	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
)

type loginTestProvider struct {
	ai.Provider
	auth authtypes.ProviderAuth
}

func (p loginTestProvider) Auth() authtypes.ProviderAuth { return p.auth }
func loginJSON(v any) string                             { raw, _ := json.Marshal(v); return string(raw) }
func waitLogin(t *testing.T, m managementTest, id, status string) loginView {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		w := m.bearer("GET", "/api/post/provider-login/"+id, "")
		if w.Code != 200 {
			t.Fatal(w.Body.String())
		}
		var view loginView
		_ = json.Unmarshal(w.Body.Bytes(), &view)
		if view.Status == status {
			return view
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("sign-in did not reach " + status)
	return loginView{}
}
func TestSubscriptionSignInIsPrivateCancellableAndPersistsEncrypted(t *testing.T) {
	oauth := &authtypes.OAuthAuth{Name: "Test subscription", Login: func(ctx context.Context, i authtypes.ProviderAuthInteraction) (*authtypes.OAuthCredential, error) {
		choice, err := i.Prompt(ctx, authtypes.AuthPrompt{Type: "select", Options: []authtypes.AuthPromptOption{{ID: "browser", Label: "Browser"}, {ID: "device_code", Label: "Device"}}})
		if err != nil {
			return nil, err
		}
		if choice != "device_code" {
			t.Error("remote sign-in did not use the SDK headless method")
		}
		uri, code := "https://example.test/authorize", "ABCD-EFGH"
		i.Notify(authtypes.AuthEvent{Type: authtypes.AuthEventDeviceCode, VerificationURI: &uri, UserCode: &code})
		answer, err := i.Prompt(ctx, authtypes.AuthPrompt{Type: authtypes.AuthPromptManualCode, Message: "Enter the authorization code"})
		if err != nil {
			return nil, err
		}
		if answer != "synthetic-code" {
			t.Error("wrong authorization response")
		}
		return authtypes.NewOAuthCredential("synthetic-refresh-secret", "synthetic-access-secret", float64(time.Now().Add(time.Hour).UnixMilli())), nil
	}}
	provider := loginTestProvider{Provider: pith.Catalog().GetProvider("openai-codex"), auth: authtypes.ProviderAuth{OAuth: oauth}}
	m := managementWithProvider(t, func(id string) ai.Provider {
		if id == "openai-codex" {
			return provider
		}
		return nil
	})
	agent := testutil.Agent(t, m.s, "oauth-agent")
	body := `{"provider":"openai-codex"}`
	if w := m.request("POST", "/api/post/provider-login", body, nil); w.Code != 401 {
		t.Fatal("anonymous sign-in")
	}
	session := m.bearer("POST", "/api/post/session", "{}")
	if w := m.request("POST", "/api/post/provider-login", body, map[string]string{"Cookie": session.Result().Cookies()[0].String()}); w.Code != 403 {
		t.Fatal("sign-in without CSRF")
	}
	w := m.bearer("POST", "/api/post/provider-login", body)
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	var view loginView
	_ = json.Unmarshal(w.Body.Bytes(), &view)
	waiting := waitLogin(t, m, view.ID, "waiting")
	if waiting.Code != "ABCD-EFGH" || waiting.URL != "https://example.test/authorize" || waiting.Prompt == nil {
		t.Fatal("SDK authorization UI missing")
	}
	col, _ := m.s.App.FindCollectionByNameOrId("_superusers")
	other := core.NewRecord(col)
	other.SetEmail("other@example.test")
	other.SetPassword("synthetic-other-password")
	if err := m.s.App.Save(other); err != nil {
		t.Fatal(err)
	}
	otherToken, _ := other.NewAuthToken()
	if w = m.request("GET", "/api/post/provider-login/"+view.ID, "", map[string]string{"Authorization": otherToken}); w.Code != 404 {
		t.Fatal("other administrator saw this sign-in")
	}
	if w = m.bearer("DELETE", "/api/post/provider-login/"+view.ID, ""); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	waitLogin(t, m, view.ID, "cancelled")
	if credential, _ := m.s.ProviderCredentials().Read(context.Background(), "openai-codex", nil); credential != nil {
		t.Fatal("cancelled sign-in saved credentials")
	}
	w = m.bearer("POST", "/api/post/provider-login", body)
	_ = json.Unmarshal(w.Body.Bytes(), &view)
	waiting = waitLogin(t, m, view.ID, "waiting")
	if w = m.bearer("POST", "/api/post/provider-login/"+view.ID, loginJSON(map[string]string{"prompt": waiting.Prompt.ID, "answer": "synthetic-code"})); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	done := waitLogin(t, m, view.ID, "succeeded")
	if done.Code != "" || done.URL != "" || done.Prompt != nil {
		t.Fatal("completed sign-in retained authorization material")
	}
	var raw []byte
	if err := m.s.App.DB().NewQuery(`SELECT value FROM post_provider_credentials WHERE provider='openai-codex'`).Row(&raw); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "synthetic-refresh-secret") || strings.Contains(string(raw), "synthetic-access-secret") {
		t.Fatal("tokens stored in plaintext")
	}
	known := pith.Catalog().GetModels("openai-codex")[0]
	level := pith.ThinkingLevels(known)[0]
	revision, _ := modelRevision(m.s.App)
	in := map[string]string{"provider": "openai-codex", "auth": "oauth", "model": known.Id, "thinking": level, "revision": revision}
	if w = m.bearer("POST", "/api/post/model-settings", loginJSON(in)); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	c, _, err := m.s.GenerationConfig(agent.ID)
	if err != nil || c.ModelAuth != "oauth" || c.ModelProvider != "openai-codex" || c.Prompt != agent.Prompt {
		t.Fatal("subscription not selected without an API key", err)
	}
	for _, path := range []string{"/api/post/model-settings", "/api/post/agents", "/api/post/provider-login/" + view.ID} {
		w = m.bearer("GET", path, "")
		if strings.Contains(w.Body.String(), "synthetic-access-secret") || strings.Contains(w.Body.String(), "synthetic-refresh-secret") {
			t.Fatal("tokens exposed through API")
		}
	}
	if w = m.bearer("POST", "/api/post/provider-logout", body); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	var count int
	_ = m.s.App.DB().NewQuery(`SELECT count(*) FROM post_provider_credentials WHERE provider={:id}`).Bind(dbx.Params{"id": "openai-codex"}).Row(&count)
	if count != 0 {
		t.Fatal("provider logout retained credential")
	}
}

func TestSubscriptionAndAPIKeyModesKeepBothCredentials(t *testing.T) {
	m := management(t)
	known := pith.Catalog().GetModels("anthropic")[0]
	level := pith.ThinkingLevels(known)[0]
	revision, _ := modelRevision(m.s.App)
	in := map[string]string{"provider": "anthropic", "auth": "api_key", "model": known.Id, "thinking": level, "key": "synthetic-retained-api-key", "revision": revision}
	if w := m.bearer("POST", "/api/post/model-settings", loginJSON(in)); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	_, err := m.s.ProviderCredentials().Modify(context.Background(), "anthropic", func(authtypes.Credential) (authtypes.Credential, error) {
		return authtypes.NewOAuthCredential("retained-refresh", "retained-access", float64(time.Now().Add(time.Hour).UnixMilli())), nil
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	revision, _ = modelRevision(m.s.App)
	delete(in, "key")
	in["revision"] = revision
	in["auth"] = "oauth"
	in["connection"] = "provider-anthropic"
	if w := m.bearer("POST", "/api/post/model-settings", loginJSON(in)); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	key, err := m.s.ConnectionKey("provider-anthropic")
	if err != nil || key != "synthetic-retained-api-key" {
		t.Fatal("subscription replaced saved API key")
	}
	revision, _ = modelRevision(m.s.App)
	in["revision"] = revision
	in["auth"] = "api_key"
	if w := m.bearer("POST", "/api/post/model-settings", loginJSON(in)); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	credential, err := m.s.ProviderCredentials().Read(context.Background(), "anthropic", nil)
	if err != nil || credential.(*authtypes.OAuthCredential).Refresh != "retained-refresh" {
		t.Fatal("API key mode discarded subscription credential")
	}
}

func TestCancelledLoginCannotOverwritePreviousSubscription(t *testing.T) {
	release := make(chan struct{})
	started := make(chan struct{})
	provider := loginTestProvider{Provider: pith.Catalog().GetProvider("openai-codex"), auth: authtypes.ProviderAuth{OAuth: &authtypes.OAuthAuth{Login: func(context.Context, authtypes.ProviderAuthInteraction) (*authtypes.OAuthCredential, error) {
		close(started)
		<-release
		return authtypes.NewOAuthCredential("late-refresh", "late-access", float64(time.Now().Add(time.Hour).UnixMilli())), nil
	}}}}
	m := managementWithProvider(t, func(string) ai.Provider { return provider })
	_, _ = m.s.ProviderCredentials().Modify(context.Background(), "openai-codex", func(authtypes.Credential) (authtypes.Credential, error) {
		return authtypes.NewOAuthCredential("previous-refresh", "previous-access", float64(time.Now().Add(time.Hour).UnixMilli())), nil
	}, nil)
	w := m.bearer("POST", "/api/post/provider-login", `{"provider":"openai-codex"}`)
	var view loginView
	_ = json.Unmarshal(w.Body.Bytes(), &view)
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("login not started")
	}
	if w = m.bearer("DELETE", "/api/post/provider-login/"+view.ID, ""); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	close(release)
	waitLogin(t, m, view.ID, "cancelled")
	credential, err := m.s.ProviderCredentials().Read(context.Background(), "openai-codex", nil)
	if err != nil || credential.(*authtypes.OAuthCredential).Refresh != "previous-refresh" {
		t.Fatal("cancelled login replaced the original account")
	}
}
