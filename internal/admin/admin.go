// Package admin serves a small embedded management view and superuser-only operations.
package admin

import (
	"context"
	"embed"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"net/http"
	"time"

	"github.com/minifish-org/pith-post/internal/agent"
	"github.com/minifish-org/pith-post/internal/domain"
	"github.com/minifish-org/pith-post/internal/matrix"
	"github.com/minifish-org/pith-post/internal/store"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
)

//go:embed web/*
var assets embed.FS

type Admin struct {
	Manager *agent.Manager
	Matrix  matrix.Factory
}

func decode(e *core.RequestEvent, v any) error {
	e.Request.Body = http.MaxBytesReader(e.Response, e.Request.Body, 128<<10)
	d := json.NewDecoder(e.Request.Body)
	d.DisallowUnknownFields()
	if err := d.Decode(v); err != nil {
		return e.BadRequestError("Invalid request body", nil)
	}
	if err := d.Decode(new(any)); err != io.EOF {
		return e.BadRequestError("Expected one JSON object", nil)
	}
	return nil
}
func (a Admin) Register(e *core.ServeEvent) {
	sub, _ := fs.Sub(assets, "web")
	e.Router.GET("/post/{path...}", func(e *core.RequestEvent) error {
		e.Response.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
		e.Response.Header().Set("X-Content-Type-Options", "nosniff")
		e.Response.Header().Set("Referrer-Policy", "no-referrer")
		e.Response.Header().Set("Cache-Control", "no-store")
		return apis.Static(sub, true)(e)
	})
	api := e.Router.Group("/api/post")
	api.Bind(apis.RequireSuperuserAuth())
	api.GET("/agents", func(e *core.RequestEvent) error {
		configs, err := a.Manager.Store.Configs()
		if err != nil {
			return e.InternalServerError("Configuration could not be loaded", nil)
		}
		type view struct {
			Config      domain.Config `json:"config"`
			State       domain.State  `json:"state"`
			Running     bool          `json:"running"`
			Review      bool          `json:"review"`
			Credentials bool          `json:"credentials"`
		}
		result := make([]view, 0, len(configs))
		for _, c := range configs {
			state, err := a.Manager.Store.State(c.ID)
			if err != nil {
				return e.InternalServerError("State could not be loaded", nil)
			}
			review, err := a.Manager.Store.HasReview(c.ID)
			if err != nil {
				return e.InternalServerError("Run status could not be loaded", nil)
			}
			secrets, secretErr := a.Manager.Store.Secrets(c.ID)
			result = append(result, view{c, state, a.Manager.Running(c.ID), review, secretErr == nil && (secrets.Password != "" || secrets.AccessToken != "")})
		}
		e.Response.Header().Set("Cache-Control", "no-store")
		return e.JSON(200, result)
	})
	api.GET("/agents/{id}/history", func(e *core.RequestEvent) error {
		id := e.Request.PathValue("id")
		if _, err := a.Manager.Store.Config(id); err != nil {
			return e.NotFoundError("Agent not found", nil)
		}
		runs, out, err := a.Manager.Store.History(id)
		if err != nil {
			return e.InternalServerError("History could not be loaded", nil)
		}
		// Do not return large binary data in the history view.
		for i := range out {
			var c domain.Content
			if json.Unmarshal([]byte(out[i].Content), &c) == nil {
				c.Data = nil
				raw, _ := json.Marshal(c)
				out[i].Content = string(raw)
			}
		}
		e.Response.Header().Set("Cache-Control", "no-store")
		return e.JSON(200, map[string]any{"runs": runs, "outbox": out})
	})
	api.POST("/agents/{id}/{action}", a.action)
}
func (a Admin) action(e *core.RequestEvent) error {
	id, action := e.Request.PathValue("id"), e.Request.PathValue("action")
	c, err := a.Manager.Store.Config(id)
	if err != nil {
		return e.NotFoundError("Agent not found", nil)
	}
	ctx, cancel := context.WithTimeout(e.Request.Context(), 90*time.Second)
	defer cancel()
	var result any = map[string]bool{"ok": true}
	switch action {
	case "start":
		err = a.Manager.Start(id)
	case "stop":
		err = a.Manager.Stop(id)
	case "restart":
		err = a.Manager.Restart(id)
	case "resume":
		err = a.Manager.Resume(id)
	case "new-conversation":
		err = a.Manager.NewConversation(id)
	case "credentials":
		var input matrix.Credentials
		if err = decode(e, &input); err != nil {
			return err
		}
		err = a.Manager.WithStopped(id, func() error { return a.Matrix.ReplaceCredentials(ctx, c, input) })
	case "trigger":
		var input struct {
			Key    string `json:"key"`
			Prompt string `json:"prompt"`
		}
		if err = decode(e, &input); err != nil {
			return err
		}
		var run string
		run, err = a.Manager.Trigger(id, input.Key, input.Prompt)
		result = map[string]string{"run": run}
	case "cancel-run":
		var input struct {
			Run string `json:"run"`
		}
		if err = decode(e, &input); err != nil {
			return err
		}
		err = a.Manager.WithStopped(id, func() error { return a.Manager.Store.CancelRun(id, input.Run) })
	case "review":
		var input struct {
			Run     string `json:"run"`
			Replay  bool   `json:"replay"`
			Confirm bool   `json:"confirm_external_effects_reviewed"`
		}
		if err = decode(e, &input); err != nil {
			return err
		}
		if !input.Confirm {
			return e.BadRequestError("Confirm that possible external effects have been reviewed", nil)
		}
		err = a.Manager.WithStopped(id, func() error { return a.Manager.Store.Review(id, input.Run, input.Replay) })
	case "confirm-recovery-impossible", "reset-identity":
		var input struct {
			Reason  string `json:"reason"`
			Confirm bool   `json:"confirm_recovery_impossible"`
		}
		if err = decode(e, &input); err != nil {
			return err
		}
		if !input.Confirm {
			return e.BadRequestError("Confirm that original identity recovery is impossible", nil)
		}
		if err = store.ValidateReason(input.Reason); err != nil {
			return e.BadRequestError(err.Error(), nil)
		}
		err = a.Manager.WithStopped(id, func() error {
			if action == "reset-identity" {
				return a.Matrix.Reset(ctx, c, input.Reason)
			}
			return a.Manager.Store.UpdateState(id, func(s *domain.State) error { s.RecoveryImpossible = input.Reason; return nil })
		})
	case "bind-room":
		var input struct {
			Room string `json:"room"`
		}
		if err = decode(e, &input); err != nil {
			return err
		}
		err = a.Manager.WithStopped(id, func() error { return a.Matrix.Bind(ctx, c, input.Room) })
	case "discard-delivery":
		var input struct {
			ID      string `json:"id"`
			Reason  string `json:"reason"`
			Confirm bool   `json:"confirm_may_already_be_visible"`
		}
		if err = decode(e, &input); err != nil {
			return err
		}
		if !input.Confirm {
			return e.BadRequestError("Confirm that the delivery may already be visible", nil)
		}
		err = a.Manager.WithStopped(id, func() error { return a.Manager.Store.DiscardDelivery(id, input.ID, input.Reason) })
	default:
		return e.NotFoundError("Unknown management operation", nil)
	}
	if err != nil {
		if errors.Is(err, domain.ErrPaused) || errors.Is(err, domain.ErrReview) || errors.Is(err, domain.ErrStopped) {
			return e.BadRequestError(err.Error(), nil)
		}
		// Intentionally exclude raw database, model, and homeserver errors from responses and logs.
		return e.BadRequestError("Operation failed. Check status, stop-state requirements, and the recovery guide.", nil)
	}
	if err = a.Manager.Store.Audit(id, action, "Administrator operation completed"); err != nil {
		return e.InternalServerError("Operation completed but audit recording failed", nil)
	}
	e.Response.Header().Set("Cache-Control", "no-store")
	return e.JSON(200, result)
}
