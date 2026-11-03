package admin

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"net"
	"net/http"
	"net/url"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/hook"
)

func randomID() string {
	var b [24]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic("secure random source unavailable")
	}
	return hex.EncodeToString(b[:])
}
func digest(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}

const sessionCookie = "pith_session"

// This runs before PocketBase's auth loader and IP policy. Bearer clients retain
// the existing API; browsers use a revocable HttpOnly session and a CSRF header.
func sessionAuth() *hook.Handler[*core.RequestEvent] {
	return &hook.Handler[*core.RequestEvent]{Priority: apis.DefaultLoadAuthTokenMiddlewarePriority - 1, Func: func(e *core.RequestEvent) error {
		e.Response.Header().Set("Cache-Control", "no-store")
		if e.Request.Header.Get("Authorization") != "" {
			return e.Next()
		}
		cookie, err := e.Request.Cookie(sessionCookie)
		if err != nil {
			return e.Next()
		}
		var session struct {
			Admin   string `db:"admin"`
			AuthKey string `db:"auth_key"`
			CSRF    string `db:"csrf"`
			Expires int64  `db:"expires"`
		}
		err = e.App.DB().NewQuery(`SELECT admin,auth_key,csrf,expires FROM post_sessions WHERE id={:id}`).Bind(dbx.Params{"id": digest(cookie.Value)}).One(&session)
		if err != nil || session.Expires <= time.Now().Unix() {
			return e.Next()
		}
		admin, err := e.App.FindRecordById(core.CollectionNameSuperusers, session.Admin)
		if err != nil || subtle.ConstantTimeCompare([]byte(digest(admin.TokenKey())), []byte(session.AuthKey)) != 1 {
			return e.Next()
		}
		if e.Request.Method != "GET" && e.Request.Method != "HEAD" && e.Request.Method != "OPTIONS" {
			if subtle.ConstantTimeCompare([]byte(e.Request.Header.Get("X-Pith-CSRF")), []byte(session.CSRF)) != 1 {
				return e.ForbiddenError("Your session needs to be refreshed before saving.", nil)
			}
			if origin := e.Request.Header.Get("Origin"); origin != "" {
				u, err := url.Parse(origin)
				if err != nil || u.Host != e.Request.Host {
					return e.ForbiddenError("Cross-origin changes are not allowed.", nil)
				}
			}
		}
		e.Auth = admin
		return e.Next()
	}}
}
func cookieSecure(e *core.RequestEvent) bool {
	host, _, err := net.SplitHostPort(e.Request.Host)
	if err != nil {
		host = e.Request.Host
	}
	ip := net.ParseIP(host)
	return e.Request.TLS != nil || e.Request.Header.Get("X-Forwarded-Proto") == "https" || (host != "localhost" && (ip == nil || !ip.IsLoopback()))
}
func (a Admin) createSession(e *core.RequestEvent) error {
	// Only an independently authenticated bearer login can establish a session.
	if e.Request.Header.Get("Authorization") == "" {
		return e.UnauthorizedError("Sign in again to start a new session.", nil)
	}
	token, csrf := randomID(), randomID()
	expires := time.Now().Add(12 * time.Hour)
	_, err := e.App.DB().NewQuery(`INSERT INTO post_sessions(id,admin,auth_key,csrf,expires) VALUES({:id},{:a},{:k},{:c},{:e})`).Bind(dbx.Params{"id": digest(token), "a": e.Auth.Id, "k": digest(e.Auth.TokenKey()), "c": csrf, "e": expires.Unix()}).Execute()
	if err != nil {
		return e.InternalServerError("Could not create a session.", nil)
	}
	_, _ = e.App.DB().NewQuery(`DELETE FROM post_sessions WHERE expires<={:t}`).Bind(dbx.Params{"t": time.Now().Unix()}).Execute()
	http.SetCookie(e.Response, &http.Cookie{Name: sessionCookie, Value: token, Path: "/api/post", HttpOnly: true, Secure: cookieSecure(e), SameSite: http.SameSiteStrictMode, Expires: expires, MaxAge: 43200})
	return e.JSON(200, map[string]any{"email": e.Auth.Email(), "csrf": csrf})
}
func (a Admin) getSession(e *core.RequestEvent) error {
	csrf := ""
	if cookie, err := e.Request.Cookie(sessionCookie); err == nil {
		_ = e.App.DB().NewQuery(`SELECT csrf FROM post_sessions WHERE id={:id} AND admin={:a} AND expires>{:t}`).Bind(dbx.Params{"id": digest(cookie.Value), "a": e.Auth.Id, "t": time.Now().Unix()}).Row(&csrf)
	}
	return e.JSON(200, map[string]any{"email": e.Auth.Email(), "csrf": csrf})
}
func (a Admin) logout(e *core.RequestEvent) error {
	if cookie, err := e.Request.Cookie(sessionCookie); err == nil {
		_, _ = e.App.DB().NewQuery(`DELETE FROM post_sessions WHERE id={:id}`).Bind(dbx.Params{"id": digest(cookie.Value)}).Execute()
	}
	clearSessionCookie(e)
	return e.JSON(200, map[string]bool{"ok": true})
}

func clearSessionCookie(e *core.RequestEvent) {
	http.SetCookie(e.Response, &http.Cookie{Name: sessionCookie, Path: "/api/post", Value: "", HttpOnly: true, Secure: cookieSecure(e), SameSite: http.SameSiteStrictMode, MaxAge: -1})
}
