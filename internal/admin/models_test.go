package admin

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"github.com/minifish-org/pith-post/internal/pith"
	"github.com/minifish-org/pith-post/internal/testutil"
)

func TestSharedModelSettingsApplyToEveryAgentAndKeepPrivateState(t *testing.T) {
	m := management(t)
	a := testutil.Agent(t, m.s, "shared-model-a")
	b := testutil.Agent(t, m.s, "shared-model-b")
	stateA, _ := m.s.State(a.ID)
	secretsA, _ := m.s.Secrets(a.ID)
	if w := m.request("GET", "/api/post/model-catalog", "", nil); w.Code != 401 {
		t.Fatal("catalog exposed")
	}
	if w := m.request("POST", "/api/post/model-settings", "{}", nil); w.Code != 401 {
		t.Fatal("anonymous model write")
	}
	revision, _ := modelRevision(m.s.App)
	body, _ := json.Marshal(map[string]any{"provider": "custom-openai", "url": "http://127.0.0.1:1/v1", "model": "local-reasoner", "thinking": "high", "key": "synthetic-global-key", "revision": revision})
	if w := m.bearer("POST", "/api/post/model-settings", string(body)); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	for _, original := range []struct{ ID, Prompt, Bot string }{{a.ID, a.Prompt, a.Bot}, {b.ID, b.Prompt, b.Bot}} {
		c, key, err := m.s.GenerationConfig(original.ID)
		if err != nil || c.Model != "local-reasoner" || c.Thinking != "high" || key != "synthetic-global-key" {
			t.Fatal("global model/thinking/key not applied", err)
		}
		if c.Prompt != original.Prompt || c.Bot != original.Bot {
			t.Fatal("model edit changed persona or identity")
		}
	}
	afterState, _ := m.s.State(a.ID)
	afterSecrets, _ := m.s.Secrets(a.ID)
	if !reflect.DeepEqual(stateA, afterState) || !reflect.DeepEqual(secretsA, afterSecrets) {
		t.Fatal("model selection reset identity")
	}
	current, err := setupDefaults(m.s.App)
	if err != nil || current.Connection != "provider-custom-openai" {
		t.Fatal("new agents would not inherit global selection")
	}
	if w := m.bearer("POST", "/api/post/model-settings", string(body)); w.Code != 409 {
		t.Fatal("stale model edit accepted")
	}
	// Switching to a native SDK model picks its endpoint/capacities without advanced inputs.
	revision, _ = modelRevision(m.s.App)
	native := pith.Catalog().GetModels("google")[0]
	level := pith.ThinkingLevels(native)[0]
	body, _ = json.Marshal(map[string]any{"provider": "google", "model": native.Id, "thinking": level, "key": "synthetic-google-key", "revision": revision})
	if w := m.bearer("POST", "/api/post/model-settings", string(body)); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	c, key, err := m.s.GenerationConfig(a.ID)
	if err != nil || c.ModelProvider != "google" || c.ModelAPI != string(native.Api) || c.ModelURL != native.BaseUrl || c.ContextWindow != int(native.ContextWindow) || key != "synthetic-google-key" {
		t.Fatal("SDK metadata was not reused", err)
	}
	revision, _ = modelRevision(m.s.App)
	body, _ = json.Marshal(map[string]any{"provider": "custom-openai", "connection": "provider-custom-openai", "model": "local-next", "url": "http://127.0.0.1:1/v1", "thinking": "medium", "revision": revision})
	if w := m.bearer("POST", "/api/post/model-settings", string(body)); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	c, key, err = m.s.GenerationConfig(b.ID)
	if err != nil || key != "synthetic-global-key" || c.Thinking != "medium" {
		t.Fatal("switching back lost saved provider key")
	}
	w := m.bearer("GET", "/api/post/model-settings", "")
	if w.Code != 200 || containsSecret(w.Body.String(), "synthetic-global-key", "synthetic-google-key") {
		t.Fatal("model settings exposed saved key")
	}
}
func containsSecret(body string, values ...string) bool {
	for _, s := range values {
		if strings.Contains(body, s) {
			return true
		}
	}
	return false
}
