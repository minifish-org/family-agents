package admin

import (
	"encoding/json"
	"net/http"
	"reflect"
	"strings"
	"testing"

	"github.com/minifish-org/pith-post/internal/testutil"
)

func TestPersonaEditsArePrivateIndependentAndKeepIdentityAndHistory(t *testing.T) {
	m := management(t)
	c := testutil.Agent(t, m.s, "persona-api")
	path := "/api/post/assistants/" + c.ID + "/persona"
	body := func(prompt, revision string) string {
		raw, _ := json.Marshal(map[string]string{"prompt": prompt, "revision": revision})
		return string(raw)
	}
	input := body("Be a patient tutor.\nExplain with simple examples.", personaRevision(c))
	if w := m.request("PATCH", path, input, nil); w.Code != http.StatusUnauthorized {
		t.Fatal("anonymous persona write")
	}
	session := m.bearer("POST", "/api/post/session", "{}")
	if w := m.request("PATCH", path, input, map[string]string{"Cookie": session.Result().Cookies()[0].String()}); w.Code != http.StatusForbidden {
		t.Fatal("persona write without CSRF")
	}
	// Appearance and availability edits must not block an independent persona edit.
	r, _ := m.s.App.FindRecordById("agents", c.ID)
	r.Set("name", "New display name")
	r.Set("auto_start", true)
	if err := m.s.App.Save(r); err != nil {
		t.Fatal(err)
	}
	before, _ := m.s.Config(c.ID)
	state, _ := m.s.State(c.ID)
	if _, err := m.s.Enqueue(c.ID, "proactive:kept-history", "A queued task stays queued"); err != nil {
		t.Fatal(err)
	}
	runs, deliveries, _ := m.s.History(c.ID)
	secrets, _ := m.s.Secrets(c.ID)
	w := m.bearer("PATCH", path, input)
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	var result map[string]string
	_ = json.Unmarshal(w.Body.Bytes(), &result)
	updated, _ := m.s.Config(c.ID)
	if updated.Prompt != "Be a patient tutor.\nExplain with simple examples." || result["revision"] != personaRevision(updated) {
		t.Fatal("persona not saved")
	}
	expected := before
	expected.Prompt = updated.Prompt
	if !reflect.DeepEqual(updated, expected) {
		t.Fatal("persona update changed model, availability, ownership or appearance")
	}
	afterState, _ := m.s.State(c.ID)
	afterSecrets, _ := m.s.Secrets(c.ID)
	afterRuns, afterDeliveries, _ := m.s.History(c.ID)
	if !reflect.DeepEqual(state, afterState) || !reflect.DeepEqual(secrets, afterSecrets) || !reflect.DeepEqual(runs, afterRuns) || !reflect.DeepEqual(deliveries, afterDeliveries) {
		t.Fatal("persona update reset identity or history")
	}
	generated, _, err := m.s.GenerationConfig(c.ID)
	if err != nil || generated.Prompt != updated.Prompt {
		t.Fatal("next model turn does not receive the updated persona")
	}
	if w = m.bearer("PATCH", path, body("Stale overwrite", personaRevision(c))); w.Code != 409 {
		t.Fatal("concurrent persona edit overwritten")
	}
	if w = m.bearer("PATCH", path, body(strings.Repeat("x", 64001), result["revision"])); w.Code != 400 {
		t.Fatal("overlong persona accepted")
	}
	kept, _ := m.s.Config(c.ID)
	if kept.Prompt != updated.Prompt {
		t.Fatal("failed persona edit changed saved instructions")
	}
	if w = m.bearer("PATCH", path, body("  \n ", result["revision"])); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	reset, _ := m.s.Config(c.ID)
	if reset.Prompt != defaultPersona {
		t.Fatal("blank persona did not use default")
	}
}
