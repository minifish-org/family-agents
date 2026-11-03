package matrix

import (
	"context"
	"errors"
	"github.com/minifish-org/pith-post/internal/domain"
	"io"
	"maunium.net/go/mautrix"
	"maunium.net/go/mautrix/id"
	"strings"
)

// Profile changes use the original account token and never recreate a crypto identity.
func (f Factory) SyncProfile(ctx context.Context, agent string) error {
	unlock := f.Store.LockProfile(agent)
	defer unlock()
	c, err := f.Store.Config(agent)
	if err != nil {
		return err
	}
	p, err := f.Store.Profile(agent)
	if err != nil {
		return err
	}
	if c.Name == p.AppliedName && p.Hash == p.AppliedHash {
		return nil
	}
	problem := "Profile saved. Connect the agent to update its Matrix profile."
	fail := func() error { _ = f.Store.ProfileResult(agent, c.Name, p.Hash, problem); return errors.New(problem) }
	secrets, err := f.Store.Secrets(agent)
	if err != nil || secrets.AccessToken == "" {
		return fail()
	}
	client, err := newClient(c, secrets.AccessToken)
	if err != nil {
		return fail()
	}
	who, err := client.Whoami(ctx)
	if err != nil || string(who.UserID) != c.Bot {
		return fail()
	}
	state, err := f.Store.State(agent)
	if err != nil || state.Device != "" && string(who.DeviceID) != state.Device {
		return fail()
	}
	problem = "Profile saved. Matrix could not be updated. Try again."
	if c.Name != p.AppliedName {
		if err = client.SetDisplayName(ctx, c.Name); err != nil {
			return fail()
		}
	}
	if p.Hash != p.AppliedHash {
		var uri id.ContentURI
		if p.Hash != "none" && p.Hash != "" {
			upload, e := client.UploadBytes(ctx, p.Avatar, "image/png")
			if e != nil {
				return fail()
			}
			uri = upload.ContentURI
		}
		if err = client.SetAvatarURL(ctx, uri); err != nil {
			return fail()
		}
	}
	return f.Store.ProfileResult(agent, c.Name, p.Hash, "")
}

// PersonProfile is a read-only snapshot of a person's Matrix profile.
type PersonProfile struct {
	DisplayName string
	AvatarURL   string
}

func (f Factory) personClient(homeserver string) (*mautrix.Client, error) {
	config := domain.Config{Homeserver: homeserver}
	token := ""
	configs, err := f.Store.Configs()
	if err != nil {
		return nil, err
	}
	for _, c := range configs {
		if strings.TrimRight(c.Homeserver, "/") != strings.TrimRight(homeserver, "/") {
			continue
		}
		secret, e := f.Store.Secrets(c.ID)
		if e == nil && secret.AccessToken != "" {
			config.Bot = c.Bot
			token = secret.AccessToken
			break
		}
	}
	return newClient(config, token)
}

func (f Factory) PersonProfile(ctx context.Context, homeserver, mxid string) (PersonProfile, error) {
	client, err := f.personClient(homeserver)
	if err != nil {
		return PersonProfile{}, err
	}
	response, err := client.GetProfile(ctx, id.UserID(mxid))
	if err != nil {
		return PersonProfile{}, err
	}
	return PersonProfile{DisplayName: response.DisplayName, AvatarURL: response.AvatarURL.String()}, nil
}

// PersonAvatar always downloads through the configured homeserver, including remote MXC media.
// Tokens never go to a URL supplied in a profile; redirects remain disabled.
func (f Factory) PersonAvatar(ctx context.Context, homeserver, source string) ([]byte, error) {
	uri, err := id.ParseContentURI(source)
	if err != nil || uri.IsEmpty() {
		return nil, errors.New("invalid Matrix avatar")
	}
	client, err := f.personClient(homeserver)
	if err != nil {
		return nil, err
	}
	response, err := client.DownloadThumbnail(ctx, uri, 256, 256, mautrix.DownloadThumbnailExtra{Method: "crop"})
	if err != nil {
		if response != nil {
			response.Body.Close()
		}
		response, err = client.Download(ctx, uri)
	}
	if err != nil {
		if response != nil {
			response.Body.Close()
		}
		return nil, err
	}
	defer response.Body.Close()
	const limit = 8 << 20
	raw, err := io.ReadAll(io.LimitReader(response.Body, limit+1))
	if err != nil || len(raw) > limit {
		return nil, errors.New("Matrix avatar could not be downloaded")
	}
	return raw, nil
}
