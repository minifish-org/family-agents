package admin

import (
	"errors"
	"strings"

	"github.com/minifish-org/pith-post/internal/domain"
	"github.com/pocketbase/pocketbase/core"
)

const defaultPersona = "You are a helpful personal assistant. Reply in the person’s language. Be concise and honest."

func personaRevision(c domain.Config) string { return digest(c.ID + "\x00" + c.Prompt) }

// Persona edits apply between turns without changing Matrix identity or restarting a conversation.
func (a Admin) savePersona(e *core.RequestEvent) error {
	var in struct {
		Prompt   string `json:"prompt"`
		Revision string `json:"revision"`
	}
	if err := decode(e, &in); err != nil {
		return err
	}
	in.Prompt = strings.TrimSpace(in.Prompt)
	if in.Prompt == "" {
		in.Prompt = defaultPersona
	}
	if len(in.Prompt) > 64000 {
		return e.BadRequestError("Keep the persona under 64 KB.", nil)
	}
	conflict := false
	var savedRevision string
	err := e.App.RunInTransaction(func(app core.App) error {
		tx := a.Manager.Store.WithApp(app)
		c, err := tx.Config(e.Request.PathValue("id"))
		if err != nil {
			return err
		}
		if in.Revision != personaRevision(c) {
			conflict = true
			return errors.New("persona changed")
		}
		r, err := app.FindRecordById("agents", c.ID)
		if err != nil {
			return err
		}
		r.Set("system_prompt", in.Prompt)
		if err = app.Save(r); err != nil {
			return err
		}
		c.Prompt = in.Prompt
		savedRevision = personaRevision(c)
		return tx.Audit(c.ID, "edit-persona", "Persona updated; applies from the next turn")
	})
	if conflict {
		return e.JSON(409, map[string]string{"message": "This persona changed in another session. Reopen the agent before saving."})
	}
	if err != nil {
		return e.BadRequestError("Could not save persona. Your changes are kept in the form.", nil)
	}
	return e.JSON(200, map[string]string{"prompt": in.Prompt, "revision": savedRevision})
}
