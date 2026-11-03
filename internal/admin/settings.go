package admin

import (
	"errors"
	"strings"

	"github.com/minifish-org/pith-post/internal/domain"
	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
)

// A person is a local address-book entry, not a Matrix or administrator account.
func (a Admin) savePerson(e *core.RequestEvent) error {
	var in struct {
		Name string `json:"name"`
		MXID string `json:"mxid"`
	}
	if err := decode(e, &in); err != nil {
		return err
	}
	in.MXID = strings.TrimSpace(in.MXID)
	if !domain.ValidMXID(in.MXID) || len(in.MXID) > 255 {
		return e.BadRequestError("Enter a full Matrix ID.", nil)
	}
	var id string
	err := e.App.RunInTransaction(func(app core.App) error {
		var record *core.Record
		var err error
		if id = e.Request.PathValue("id"); id != "" {
			record, err = app.FindRecordById("owners", id)
			if err != nil {
				return err
			}
			if record.GetString("mxid") != in.MXID {
				return errors.New("Matrix identity cannot be changed")
			}
		} else {
			col, err := app.FindCollectionByNameOrId("owners")
			if err != nil {
				return err
			}
			record = core.NewRecord(col)
			record.Set("mxid", in.MXID)
			name := []rune(in.MXID)
			if len(name) > 100 {
				name = name[:100]
			}
			record.Set("name", string(name))
		}
		if err = app.Save(record); err != nil {
			return err
		}
		id = record.Id
		return nil
	})
	if err != nil {
		return e.BadRequestError("Could not save this person. Use a unique Matrix ID; an existing person's Matrix ID cannot change.", nil)
	}
	_ = a.refreshPerson(e.Request.Context(), id, true)
	return e.JSON(200, map[string]string{"id": id})
}

func (a Admin) deletePerson(e *core.RequestEvent) error {
	id := e.Request.PathValue("id")
	err := e.App.RunInTransaction(func(app core.App) error {
		var count int
		if err := app.DB().NewQuery(`SELECT count(*) FROM agents WHERE owner={:id}`).Bind(dbx.Params{"id": id}).Row(&count); err != nil {
			return err
		}
		if count != 0 {
			return errors.New("person is still assigned")
		}
		r, err := app.FindRecordById("owners", id)
		if err != nil {
			return err
		}
		if err = app.Delete(r); err != nil {
			return err
		}
		for _, table := range []string{"post_person_profiles", "post_person_avatars"} {
			if _, err = app.DB().NewQuery("DELETE FROM " + table + " WHERE person={:id}").Bind(dbx.Params{"id": id}).Execute(); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return e.BadRequestError("Only a person with no assistants can be removed. Their Matrix account is kept.", nil)
	}
	return e.JSON(200, map[string]bool{"ok": true})
}

func (a Admin) account(e *core.RequestEvent) error {
	field := e.Auth.Collection().Fields.GetByName(core.FieldNamePassword).(*core.PasswordField)
	return e.JSON(200, map[string]any{"email": e.Auth.Email(), "password_min": field.Min, "password_max": field.Max})
}

func (a Admin) changePassword(e *core.RequestEvent) error {
	var in struct {
		Current  string `json:"current_password"`
		Password string `json:"password"`
		Confirm  string `json:"confirm"`
	}
	if err := decode(e, &in); err != nil {
		return err
	}
	if in.Current == "" || len(in.Current) > 16384 || in.Password == "" || len(in.Password) > 16384 || in.Password != in.Confirm {
		return e.BadRequestError("Enter your current password and matching new passwords.", nil)
	}
	err := e.App.RunInTransaction(func(app core.App) error {
		r, err := app.FindRecordById(core.CollectionNameSuperusers, e.Auth.Id)
		if err != nil {
			return err
		}
		if r.TokenKey() != e.Auth.TokenKey() || !r.ValidatePassword(in.Current) {
			return errors.New("current password did not match")
		}
		r.SetPassword(in.Password)
		if err = app.Save(r); err != nil {
			return err
		}
		_, err = app.DB().NewQuery(`DELETE FROM post_sessions WHERE admin={:id}`).Bind(dbx.Params{"id": r.Id}).Execute()
		return err
	})
	if err != nil {
		return e.BadRequestError("Password was not changed. Check your current password and the installation's password requirements.", nil)
	}
	clearSessionCookie(e)
	return e.JSON(200, map[string]bool{"ok": true})
}
