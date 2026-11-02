package store

import (
	"errors"

	"github.com/minifish-org/pith-post/internal/domain"
	"github.com/pocketbase/pocketbase/core"
)

// EnsureSchema installs locked collections. Nil API rules mean superusers only.
func EnsureSchema(app core.App) error {
	owners, err := app.FindCollectionByNameOrId("owners")
	if err != nil {
		owners = core.NewBaseCollection("owners")
		owners.Fields.Add(&core.TextField{Name: "name", Required: true, Max: 100}, &core.TextField{Name: "mxid", Required: true, Max: 255})
		owners.AddIndex("idx_owner_mxid", true, "mxid", "")
		if err = app.Save(owners); err != nil {
			return err
		}
	}
	if _, err = app.FindCollectionByNameOrId("agents"); err == nil {
		return nil
	}
	agents := core.NewBaseCollection("agents")
	agents.Fields.Add(
		&core.TextField{Name: "name", Required: true, Max: 100},
		&core.RelationField{Name: "owner", Required: true, CollectionId: owners.Id, MaxSelect: 1, CascadeDelete: false},
		&core.TextField{Name: "bot_mxid", Required: true, Max: 255},
		&core.TextField{Name: "homeserver", Required: true, Max: 2048},
		&core.TextField{Name: "system_prompt", Required: true, Max: 64000},
		&core.TextField{Name: "model", Required: true, Max: 255},
		&core.TextField{Name: "model_url", Required: true, Max: 2048},
		&core.SelectField{Name: "model_api", Required: true, MaxSelect: 1, Values: []string{"openai-completions", "openai-responses", "anthropic-messages"}},
		&core.NumberField{Name: "context_window", Required: true, OnlyInt: true},
		&core.NumberField{Name: "max_tokens", Required: true, OnlyInt: true},
		&core.BoolField{Name: "auto_start"}, &core.BoolField{Name: "auto_reset"},
	)
	agents.AddIndex("idx_bot_mxid", true, "bot_mxid", "")
	return app.Save(agents)
}

func RegisterValidation(app core.App) {
	app.OnRecordValidate("owners").BindFunc(func(e *core.RecordEvent) error {
		if !domain.ValidMXID(e.Record.GetString("mxid")) {
			return errors.New("owner must have a full Matrix user ID")
		}
		if !e.Record.IsNew() && e.Record.Original().GetString("mxid") != e.Record.GetString("mxid") {
			return errors.New("owner Matrix ID is immutable; create a new owner instead")
		}
		return e.Next()
	})
	app.OnRecordValidate("agents").BindFunc(func(e *core.RecordEvent) error {
		if _, err := ConfigFromRecord(e.App, e.Record); err != nil {
			return err
		}
		if !e.Record.IsNew() {
			for _, field := range []string{"owner", "bot_mxid", "homeserver"} {
				if e.Record.Original().GetString(field) != e.Record.GetString(field) {
					return errors.New("agent ownership and Matrix identity are immutable; create a new agent instead")
				}
			}
		}
		return e.Next()
	})
}
