package matrix

import (
	"context"
	"github.com/minifish-org/pith-post/internal/domain"
	"github.com/minifish-org/pith-post/internal/testutil"
	"github.com/pocketbase/dbx"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestPersonProfileIsReadOnlyAndTokensStayOnTheConfiguredServer(t *testing.T) {
	s := testutil.Store(t)
	c := testutil.Agent(t, s, "profile-reader")
	_ = s.PutSecrets(c.ID, domain.Secrets{AccessToken: "synthetic-reader-token"})
	expectedToken := ""
	redirect := false
	forwarded := 0
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { forwarded++ }))
	defer other.Close()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" || !strings.HasSuffix(r.URL.Path, "/profile/@moonfish:example.test") {
			t.Error("person profile lookup attempted an unexpected operation")
		}
		if r.Header.Get("Authorization") != expectedToken {
			t.Error("a token belonging to a different server was attached")
		}
		if redirect {
			http.Redirect(w, r, other.URL, http.StatusFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"displayname":"Luna"}`))
	}))
	defer server.Close()
	f := Factory{Store: s}
	name, err := f.PersonProfile(context.Background(), server.URL, "@moonfish:example.test")
	if err != nil || name.DisplayName != "Luna" {
		t.Fatal("display name did not come from Matrix", err)
	}
	_, _ = s.App.DB().NewQuery(`UPDATE agents SET homeserver={:url} WHERE id={:id}`).Bind(dbx.Params{"url": server.URL, "id": c.ID}).Execute()
	expectedToken = "Bearer synthetic-reader-token"
	if name, err = f.PersonProfile(context.Background(), server.URL, "@moonfish:example.test"); err != nil || name.DisplayName != "Luna" {
		t.Fatal("authenticated profile lookup failed", err)
	}
	redirect = true
	if _, err = f.PersonProfile(context.Background(), server.URL, "@moonfish:example.test"); err == nil {
		t.Fatal("profile lookup followed a redirect")
	}
	if forwarded != 0 {
		t.Fatal("profile lookup forwarded its credentials")
	}
}

func TestPersonAvatarMediaStaysOnConfiguredServerAndRejectsRedirects(t *testing.T) {
	s := testutil.Store(t)
	c := testutil.Agent(t, s, "person-media")
	_ = s.PutSecrets(c.ID, domain.Secrets{AccessToken: "synthetic-media-token"})
	expected := ""
	redirect := false
	forwarded := 0
	fallback := false
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { forwarded++ }))
	defer other.Close()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" || !strings.HasPrefix(r.URL.Path, "/_matrix/client/v1/media/") || !strings.HasSuffix(r.URL.Path, "/remote.example.test/avatar") {
			t.Error("unexpected media request")
		}
		if r.Header.Get("Authorization") != expected {
			t.Error("wrong server token used")
		}
		if redirect {
			http.Redirect(w, r, other.URL, 302)
			return
		}
		if fallback && strings.Contains(r.URL.Path, "/thumbnail/") {
			w.WriteHeader(404)
			return
		}
		_, _ = w.Write([]byte("synthetic-image"))
	}))
	defer server.Close()
	f := Factory{Store: s}
	if raw, err := f.PersonAvatar(context.Background(), server.URL, "mxc://remote.example.test/avatar"); err != nil || string(raw) != "synthetic-image" {
		t.Fatal("anonymous media lookup failed", err)
	}
	_, _ = s.App.DB().NewQuery(`UPDATE agents SET homeserver={:url} WHERE id={:id}`).Bind(dbx.Params{"url": server.URL, "id": c.ID}).Execute()
	expected = "Bearer synthetic-media-token"
	fallback = true
	if _, err := f.PersonAvatar(context.Background(), server.URL, "mxc://remote.example.test/avatar"); err != nil {
		t.Fatal("authenticated fallback failed", err)
	}
	redirect = true
	if _, err := f.PersonAvatar(context.Background(), server.URL, "mxc://remote.example.test/avatar"); err == nil {
		t.Fatal("media redirect accepted")
	}
	if forwarded != 0 {
		t.Fatal("credentials forwarded to redirected host")
	}
	if _, err := f.PersonAvatar(context.Background(), server.URL, other.URL); err == nil {
		t.Fatal("non-MXC image accepted")
	}
}
