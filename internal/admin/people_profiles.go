package admin

import (
	"context"
	"strings"
	"time"

	"github.com/minifish-org/pith-post/internal/matrix"
	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
)

func (a Admin) lookupPersonProfile(ctx context.Context, mxid string) (matrix.PersonProfile, error) {
	if a.PersonProfileLookup != nil {
		return a.PersonProfileLookup(ctx, mxid)
	}
	settings, err := setupDefaults(a.Manager.Store.App)
	if err != nil {
		return matrix.PersonProfile{}, err
	}
	return a.Matrix.PersonProfile(ctx, settings.Homeserver, mxid)
}

func (a Admin) personAvatar(e *core.RequestEvent) error {
	id := e.Request.PathValue("id")
	if _, err := e.App.FindRecordById("owners", id); err != nil {
		return e.NotFoundError("Person not found.", nil)
	}
	p, err := a.Manager.Store.PersonAvatar(id)
	if err != nil || len(p.Avatar) == 0 {
		return e.NotFoundError("No avatar.", nil)
	}
	e.Response.Header().Set("Cache-Control", "private, no-cache")
	e.Response.Header().Set("X-Content-Type-Options", "nosniff")
	return e.Blob(200, "image/png", p.Avatar)
}

// Reads never write back to Matrix: the person's Matrix profile is the source of truth.
func (a Admin) refreshPerson(ctx context.Context, person string, force bool) error {
	unlock := a.Manager.Store.LockProfile("person:" + person)
	defer unlock()
	var stamp struct {
		Checked     int64 `db:"checked"`
		Failed      bool  `db:"failed"`
		AvatarKnown bool  `db:"avatar_known"`
	}
	_ = a.Manager.Store.App.DB().NewQuery(`SELECT p.checked,p.failed,a.person IS NOT NULL AS avatar_known FROM post_person_profiles p LEFT JOIN post_person_avatars a ON a.person=p.person WHERE p.person={:id}`).Bind(dbx.Params{"id": person}).One(&stamp)
	ttl := int64(60)
	if stamp.Failed {
		ttl = 15
	}
	if !force && time.Now().Unix()-stamp.Checked < ttl && (stamp.Failed || stamp.AvatarKnown) {
		return nil
	}
	r, err := a.Manager.Store.App.FindRecordById("owners", person)
	if err != nil {
		return err
	}
	profileCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	profile, lookupErr := a.lookupPersonProfile(profileCtx, r.GetString("mxid"))
	name := profile.DisplayName
	avatar, cacheErr := a.Manager.Store.PersonAvatar(person)
	if cacheErr != nil {
		return cacheErr
	}
	avatarKnown := false
	avatarFailed := false
	if lookupErr == nil {
		if profile.AvatarURL == "" {
			avatar.Avatar = nil
			avatarKnown = true
		} else if avatar.Source == profile.AvatarURL && avatar.Hash != "" {
			avatarKnown = true
		} else {
			settings, err := setupDefaults(a.Manager.Store.App)
			if err == nil {
				var raw []byte
				raw, err = a.Matrix.PersonAvatar(profileCtx, settings.Homeserver, profile.AvatarURL)
				if err == nil {
					avatar.Avatar, err = normalizeAvatar(raw)
				}
			}
			avatarKnown = err == nil
			avatarFailed = err != nil
		}
	}
	return a.Manager.Store.App.RunInTransaction(func(app core.App) error {
		current, err := app.FindRecordById("owners", person)
		if err != nil {
			return err
		}
		if lookupErr == nil {
			name = strings.TrimSpace(name)
			if name == "" {
				name = current.GetString("mxid")
			}
			chars := []rune(name)
			if len(chars) > 100 {
				name = string(chars[:100])
			}
			if name != current.GetString("name") {
				current.Set("name", name)
				if err = app.Save(current); err != nil {
					return err
				}
			}
		}
		if avatarKnown {
			if err := a.Manager.Store.WithApp(app).SavePersonAvatar(person, profile.AvatarURL, avatar.Avatar); err != nil {
				return err
			}
		}
		_, err = app.DB().NewQuery(`INSERT INTO post_person_profiles(person,checked,failed) VALUES({:id},{:now},{:failed}) ON CONFLICT(person) DO UPDATE SET checked=excluded.checked,failed=excluded.failed`).Bind(dbx.Params{"id": person, "now": time.Now().Unix(), "failed": lookupErr != nil || avatarFailed}).Execute()
		return err
	})
}
func (a Admin) refreshPersonSoon(id string) {
	a.Manager.Background(func(ctx context.Context) { _ = a.refreshPerson(ctx, id, false) })
}
