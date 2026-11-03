package admin

import (
	"bytes"
	"context"
	"errors"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	"image/png"
	"io"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/minifish-org/pith-post/internal/domain"
	"github.com/pocketbase/pocketbase/core"
	"golang.org/x/image/draw"
	_ "golang.org/x/image/webp"
)

func (a Admin) syncAppearance(id string) {
	a.Manager.Background(func(parent context.Context) {
		ctx, cancel := context.WithTimeout(parent, 15*time.Second)
		defer cancel()
		_ = a.Matrix.SyncProfile(ctx, id)
	})
}
func (a Admin) getAvatar(e *core.RequestEvent) error {
	id := e.Request.PathValue("id")
	if _, err := a.Manager.Store.Config(id); err != nil {
		return e.NotFoundError("Agent not found.", nil)
	}
	p, err := a.Manager.Store.Profile(id)
	if err != nil || len(p.Avatar) == 0 {
		return e.NotFoundError("No avatar.", nil)
	}
	e.Response.Header().Set("Cache-Control", "private, no-cache")
	e.Response.Header().Set("X-Content-Type-Options", "nosniff")
	return e.Blob(200, "image/png", p.Avatar)
}
func (a Admin) putAvatar(e *core.RequestEvent) error {
	id := e.Request.PathValue("id")
	if _, err := a.Manager.Store.Config(id); err != nil {
		return e.NotFoundError("Agent not found.", nil)
	}
	e.Request.Body = http.MaxBytesReader(e.Response, e.Request.Body, 2<<20)
	raw, err := io.ReadAll(e.Request.Body)
	if err != nil {
		return e.BadRequestError("Choose an image smaller than 2 MB.", nil)
	}
	image, err := normalizeAvatar(raw)
	if err != nil {
		return e.BadRequestError(err.Error(), nil)
	}
	if err = a.Manager.Store.SaveAvatar(id, image); err != nil {
		return e.InternalServerError("Could not save image.", nil)
	}
	a.syncAppearance(id)
	return e.JSON(200, map[string]bool{"ok": true})
}
func (a Admin) removeAvatar(e *core.RequestEvent) error {
	id := e.Request.PathValue("id")
	if _, err := a.Manager.Store.Config(id); err != nil {
		return e.NotFoundError("Agent not found.", nil)
	}
	if err := a.Manager.Store.SaveAvatar(id, nil); err != nil {
		return e.InternalServerError("Could not remove image.", nil)
	}
	a.syncAppearance(id)
	return e.JSON(200, map[string]bool{"ok": true})
}
func appearanceRevision(c domain.Config) string { return digest(c.ID + "\x00" + c.Name) }

func (a Admin) saveAppearance(e *core.RequestEvent) error {
	var in struct {
		Name     string `json:"name"`
		Revision string `json:"revision"`
	}
	if err := decode(e, &in); err != nil {
		return err
	}
	in.Name = strings.TrimSpace(in.Name)
	if in.Name == "" || utf8.RuneCountInString(in.Name) > 100 {
		return e.BadRequestError("Enter a display name up to 100 characters.", nil)
	}
	conflict := false
	var savedRevision string
	err := e.App.RunInTransaction(func(app core.App) error {
		c, err := a.Manager.Store.WithApp(app).Config(e.Request.PathValue("id"))
		if err != nil {
			return err
		}
		if in.Revision != appearanceRevision(c) {
			conflict = true
			return errors.New("revision changed")
		}
		r, err := app.FindRecordById("agents", c.ID)
		if err != nil {
			return err
		}
		r.Set("name", in.Name)
		if err = app.Save(r); err != nil {
			return err
		}
		c.Name = in.Name
		savedRevision = appearanceRevision(c)
		return nil
	})
	if conflict {
		return e.JSON(409, map[string]string{"message": "This agent changed in another session. Reopen it before saving."})
	}
	if err != nil {
		return e.BadRequestError("Could not save display name.", nil)
	}
	a.syncAppearance(e.Request.PathValue("id"))
	return e.JSON(200, map[string]any{"ok": true, "revision": savedRevision})
}

func normalizeAvatar(raw []byte) ([]byte, error) {
	config, format, err := image.DecodeConfig(bytes.NewReader(raw))
	if err != nil || config.Width < 1 || config.Height < 1 || config.Width > 4096 || config.Height > 4096 || (format != "png" && format != "jpeg" && format != "gif" && format != "webp") {
		return nil, errors.New("Choose a PNG, JPEG, GIF or WebP image up to 4096 × 4096 pixels.")
	}
	original, _, err := image.Decode(bytes.NewReader(raw))
	if err != nil {
		return nil, errors.New("This image could not be opened.")
	}
	bounds := original.Bounds()
	size := min(bounds.Dx(), bounds.Dy())
	x := bounds.Min.X + (bounds.Dx()-size)/2
	y := bounds.Min.Y + (bounds.Dy()-size)/2
	avatar := image.NewNRGBA(image.Rect(0, 0, 256, 256))
	draw.CatmullRom.Scale(avatar, avatar.Bounds(), original, image.Rect(x, y, x+size, y+size), draw.Src, nil)
	var encoded bytes.Buffer
	if err = png.Encode(&encoded, avatar); err != nil {
		return nil, errors.New("Could not save image.")
	}
	return encoded.Bytes(), nil
}
