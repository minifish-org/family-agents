package admin

import (
	"bytes"
	"encoding/json"
	"github.com/minifish-org/pith-post/internal/testutil"
	"image"
	"image/color"
	"image/png"
	"strings"
	"testing"
)

func TestAvatarUploadIsPrivateValidatedAndNormalized(t *testing.T) {
	m := management(t)
	c := testutil.Agent(t, m.s, "avatar-api")
	path := "/api/post/assistants/" + c.ID + "/avatar"
	source := image.NewNRGBA(image.Rect(0, 0, 16, 8))
	source.Set(8, 4, color.NRGBA{R: 25, G: 110, B: 230, A: 255})
	var raw bytes.Buffer
	_ = png.Encode(&raw, source)
	if w := m.request("PUT", path, raw.String(), nil); w.Code != 401 {
		t.Fatal("anonymous avatar upload")
	}
	w := m.bearer("POST", "/api/post/session", "{}")
	headers := map[string]string{"Cookie": w.Result().Cookies()[0].String()}
	if w = m.request("PUT", path, raw.String(), headers); w.Code != 403 {
		t.Fatal("avatar write did not require CSRF")
	}
	if w = m.bearer("PUT", path, raw.String()); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	w = m.bearer("GET", path, "")
	if w.Code != 200 || w.Header().Get("Content-Type") != "image/png" {
		t.Fatal("avatar was not served as PNG")
	}
	config, _, err := image.DecodeConfig(bytes.NewReader(w.Body.Bytes()))
	if err != nil || config.Width != 256 || config.Height != 256 {
		t.Fatal("avatar was not normalized")
	}
	before, _ := m.s.Profile(c.ID)
	for _, body := range []string{`<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`, string(bytes.Repeat([]byte{'x'}, (2<<20)+1))} {
		if w = m.bearer("PUT", path, body); w.Code != 400 {
			t.Fatal("unsafe/oversized image accepted")
		}
	}
	after, _ := m.s.Profile(c.ID)
	if !bytes.Equal(before.Avatar, after.Avatar) || before.Hash != after.Hash {
		t.Fatal("failed upload destroyed the existing image")
	}
	if w = m.request("GET", path, "", nil); w.Code != 401 {
		t.Fatal("private avatar leaked")
	}
	if w = m.bearer("DELETE", path, ""); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	if w = m.bearer("GET", path, ""); w.Code != 404 {
		t.Fatal("removed avatar still served")
	}
}

func TestAppearanceEditsPreserveAgentIdentityAndPrompt(t *testing.T) {
	m := management(t)
	c := testutil.Agent(t, m.s, "rename-api")
	state, _ := m.s.State(c.ID)
	body, _ := json.Marshal(map[string]string{"name": "Renamed agent", "revision": appearanceRevision(c)})
	path := "/api/post/assistants/" + c.ID + "/appearance"
	w := m.bearer("PATCH", path, string(body))
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	var saved map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &saved)
	if saved["revision"] == appearanceRevision(c) || saved["revision"] == "" {
		t.Fatal("new revision missing")
	}
	if w = m.bearer("PATCH", path, string(body)); w.Code != 409 {
		t.Fatal("stale edit overwrote a newer profile")
	}
	updated, _ := m.s.Config(c.ID)
	after, _ := m.s.State(c.ID)
	if updated.Name != "Renamed agent" || updated.Bot != c.Bot || updated.OwnerID != c.OwnerID || updated.Homeserver != c.Homeserver || updated.Prompt != c.Prompt || updated.Model != c.Model || after.Device != state.Device || after.Room != state.Room {
		t.Fatal("appearance edit changed identity or model behavior")
	}
}

func TestAppearanceNamesUseCharacterLimitsAndIgnoreUnrelatedConfigurationEdits(t *testing.T) {
	m := management(t)
	c := testutil.Agent(t, m.s, "unicode-name")
	r, err := m.s.App.FindRecordById("agents", c.ID)
	if err != nil {
		t.Fatal(err)
	}
	r.Set("auto_start", true)
	r.Set("system_prompt", "An independently updated prompt")
	if err = m.s.App.Save(r); err != nil {
		t.Fatal(err)
	}
	name := strings.Repeat("星", 100)
	body, _ := json.Marshal(map[string]string{"name": name, "revision": appearanceRevision(c)})
	path := "/api/post/assistants/" + c.ID + "/appearance"
	if w := m.bearer("PATCH", path, string(body)); w.Code != 200 {
		t.Fatal("unrelated configuration changes or Unicode bytes blocked a valid name", w.Body.String())
	}
	updated, _ := m.s.Config(c.ID)
	if updated.Name != name || !updated.AutoStart || updated.Prompt != "An independently updated prompt" {
		t.Fatal("profile edit overwrote unrelated settings")
	}
	body, _ = json.Marshal(map[string]string{"name": strings.Repeat("星", 101), "revision": appearanceRevision(updated)})
	if w := m.bearer("PATCH", path, string(body)); w.Code != 400 {
		t.Fatal("overlong name accepted")
	}
}
