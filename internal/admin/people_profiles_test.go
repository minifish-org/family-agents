package admin

import (
	"bytes"
	"context"
	"errors"
	"github.com/minifish-org/pith-post/internal/agent"
	"github.com/minifish-org/pith-post/internal/matrix"
	"github.com/minifish-org/pith-post/internal/testutil"
	"github.com/pocketbase/dbx"
	"image"
	"image/png"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestPersonNamesFollowMatrixAndFailuresKeepTheCachedName(t *testing.T) {
	m := management(t)
	original := testutil.Agent(t, m.s, "person-profile")
	manager := agent.New(m.s, nil, nil)
	defer manager.Close()
	name := "Luna"
	failed := false
	calls := 0
	a := Admin{Manager: manager, PersonProfileLookup: func(context.Context, string) (matrix.PersonProfile, error) {
		calls++
		if failed {
			return matrix.PersonProfile{}, errors.New("unavailable")
		}
		return matrix.PersonProfile{DisplayName: name}, nil
	}}
	beforeRevision := revision(original)
	if err := a.refreshPerson(context.Background(), original.OwnerID, false); err != nil {
		t.Fatal(err)
	}
	current, _ := m.s.Config(original.ID)
	if current.OwnerName != "Luna" || current.OwnerID != original.OwnerID || current.Owner != original.Owner {
		t.Fatal("Matrix name lookup changed ownership or did not refresh the name")
	}
	if revision(current) != beforeRevision {
		t.Fatal("a display-name refresh invalidated an unrelated agent edit")
	}
	name = "Moon fish"
	if err := a.refreshPerson(context.Background(), original.OwnerID, false); err != nil {
		t.Fatal(err)
	}
	if calls != 1 {
		t.Fatal("cached names caused repeated network lookups")
	}
	if err := a.refreshPerson(context.Background(), original.OwnerID, true); err != nil {
		t.Fatal(err)
	}
	current, _ = m.s.Config(original.ID)
	if current.OwnerName != name {
		t.Fatal("a changed Matrix display name was not reflected")
	}
	failed = true
	if err := a.refreshPerson(context.Background(), original.OwnerID, true); err != nil {
		t.Fatal(err)
	}
	current, _ = m.s.Config(original.ID)
	if current.OwnerName != "Moon fish" {
		t.Fatal("network failure cleared the last known display name")
	}
	failed = false
	name = ""
	_, _ = m.s.App.DB().NewQuery(`UPDATE post_person_profiles SET checked=0 WHERE person={:id}`).Bind(dbx.Params{"id": original.OwnerID}).Execute()
	if err := a.refreshPerson(context.Background(), original.OwnerID, false); err != nil {
		t.Fatal(err)
	}
	current, _ = m.s.Config(original.ID)
	if current.OwnerName != original.Owner {
		t.Fatal("an account without a display name did not fall back to its Matrix ID")
	}
}

func TestPersonAvatarsAreCachedPrivateAndPreservedOnFailures(t *testing.T) {
	m := management(t)
	c := testutil.Agent(t, m.s, "person-avatar")
	manager := agent.New(m.s, nil, nil)
	defer manager.Close()
	var raw bytes.Buffer
	_ = png.Encode(&raw, image.NewNRGBA(image.Rect(0, 0, 16, 8)))
	downloads := 0
	broken := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		downloads++
		if broken {
			w.WriteHeader(503)
			return
		}
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write(raw.Bytes())
	}))
	defer server.Close()
	if err := putDefaults(m.s.App, SetupDefaults{Homeserver: server.URL}); err != nil {
		t.Fatal(err)
	}
	profile := matrix.PersonProfile{DisplayName: "Luna", AvatarURL: "mxc://remote.example.test/first"}
	unavailable := false
	a := Admin{Manager: manager, Matrix: matrix.Factory{Store: m.s}, PersonProfileLookup: func(context.Context, string) (matrix.PersonProfile, error) {
		if unavailable {
			return matrix.PersonProfile{}, errors.New("unavailable")
		}
		return profile, nil
	}}
	// A pre-upgrade fresh name cache must still fetch the new avatar immediately.
	_, err := m.s.App.DB().NewQuery(`INSERT INTO post_person_profiles(person,checked,failed) VALUES({:id},strftime('%s','now'),0)`).Bind(dbx.Params{"id": c.OwnerID}).Execute()
	if err != nil {
		t.Fatal(err)
	}
	if err = a.refreshPerson(context.Background(), c.OwnerID, false); err != nil {
		t.Fatal(err)
	}
	avatar, err := m.s.PersonAvatar(c.OwnerID)
	if err != nil || avatar.Hash == "" || avatar.Source != profile.AvatarURL {
		t.Fatal("Matrix avatar not cached", err)
	}
	config, _, err := image.DecodeConfig(bytes.NewReader(avatar.Avatar))
	if err != nil || config.Width != 256 || config.Height != 256 {
		t.Fatal("avatar was not normalized")
	}
	path := "/api/post/owners/" + c.OwnerID + "/avatar"
	if w := m.request("GET", path, "", nil); w.Code != 401 {
		t.Fatal("anonymous person avatar read allowed")
	}
	if w := m.bearer("GET", path, ""); w.Code != 200 || w.Header().Get("Content-Type") != "image/png" || !bytes.Equal(w.Body.Bytes(), avatar.Avatar) {
		t.Fatal("cached image unavailable")
	}
	if err = a.refreshPerson(context.Background(), c.OwnerID, true); err != nil {
		t.Fatal(err)
	}
	if downloads != 1 {
		t.Fatal("unchanged MXC image downloaded repeatedly")
	}
	unavailable = true
	if err = a.refreshPerson(context.Background(), c.OwnerID, true); err != nil {
		t.Fatal(err)
	}
	kept, _ := m.s.PersonAvatar(c.OwnerID)
	if kept.Hash != avatar.Hash {
		t.Fatal("profile failure cleared cached avatar")
	}
	unavailable = false
	broken = true
	profile.AvatarURL = "mxc://remote.example.test/changed"
	profile.DisplayName = "New name"
	if err = a.refreshPerson(context.Background(), c.OwnerID, true); err != nil {
		t.Fatal(err)
	}
	kept, _ = m.s.PersonAvatar(c.OwnerID)
	if kept.Hash != avatar.Hash || kept.Source != avatar.Source {
		t.Fatal("media failure replaced cached avatar")
	}
	current, _ := m.s.Config(c.ID)
	if current.OwnerName != "New name" {
		t.Fatal("media failure blocked a valid display name")
	}
	broken = false
	if err = a.refreshPerson(context.Background(), c.OwnerID, true); err != nil {
		t.Fatal(err)
	}
	kept, _ = m.s.PersonAvatar(c.OwnerID)
	if kept.Source != profile.AvatarURL {
		t.Fatal("avatar did not recover")
	}
	profile.AvatarURL = ""
	if err = a.refreshPerson(context.Background(), c.OwnerID, true); err != nil {
		t.Fatal(err)
	}
	cleared, _ := m.s.PersonAvatar(c.OwnerID)
	if cleared.Hash != "" || len(cleared.Avatar) != 0 {
		t.Fatal("Matrix removal left stale avatar")
	}
	if w := m.bearer("GET", path, ""); w.Code != 404 {
		t.Fatal("removed avatar still served")
	}
	if w := m.bearer("DELETE", "/api/post/assistants/"+c.ID, ""); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	if w := m.bearer("DELETE", "/api/post/owners/"+c.OwnerID, ""); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	var count int
	_ = m.s.App.DB().NewQuery(`SELECT count(*) FROM post_person_avatars WHERE person={:id}`).Bind(dbx.Params{"id": c.OwnerID}).Row(&count)
	if count != 0 {
		t.Fatal("removed person's avatar cache retained")
	}
}
