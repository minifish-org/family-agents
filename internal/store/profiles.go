package store

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"github.com/pocketbase/dbx"
	"sync"
)

type AgentProfile struct {
	Avatar      []byte `db:"avatar" json:"-"`
	Hash        string `db:"avatar_hash" json:"avatar"`
	AppliedName string `db:"applied_name" json:"-"`
	AppliedHash string `db:"applied_hash" json:"-"`
	Error       string `db:"error" json:"error"`
}

func (s *Store) Profile(id string) (AgentProfile, error) {
	var p AgentProfile
	err := s.App.DB().NewQuery(`SELECT * FROM post_agent_profiles WHERE agent={:id}`).Bind(dbx.Params{"id": id}).One(&p)
	if errors.Is(err, sql.ErrNoRows) {
		return p, nil
	}
	return p, err
}
func (s *Store) SaveAvatar(id string, png []byte) error {
	hash := "none"
	if len(png) > 0 {
		sum := sha256.Sum256(png)
		hash = hex.EncodeToString(sum[:])
	}
	_, err := s.App.DB().NewQuery(`INSERT INTO post_agent_profiles(agent,avatar,avatar_hash) VALUES({:id},{:image},{:hash}) ON CONFLICT(agent) DO UPDATE SET avatar=excluded.avatar,avatar_hash=excluded.avatar_hash,error=''`).Bind(dbx.Params{"id": id, "image": png, "hash": hash}).Execute()
	return err
}
func (s *Store) ProfileResult(id, name, hash, problem string) error {
	if _, err := s.App.DB().NewQuery(`INSERT OR IGNORE INTO post_agent_profiles(agent) VALUES({:id})`).Bind(dbx.Params{"id": id}).Execute(); err != nil {
		return err
	}
	if problem != "" {
		_, err := s.App.DB().NewQuery(`UPDATE post_agent_profiles SET error={:error} WHERE agent={:id} AND avatar_hash={:hash}`).Bind(dbx.Params{"id": id, "hash": hash, "error": problem}).Execute()
		return err
	}
	_, err := s.App.DB().NewQuery(`UPDATE post_agent_profiles SET applied_name={:name},applied_hash={:hash},error='' WHERE agent={:id} AND avatar_hash={:hash}`).Bind(dbx.Params{"id": id, "hash": hash, "name": name}).Execute()
	return err
}
func (s *Store) LockProfile(id string) func() {
	value, _ := s.profileLocks.LoadOrStore(id, &sync.Mutex{})
	mu := value.(*sync.Mutex)
	mu.Lock()
	return mu.Unlock
}

// PersonAvatar contains only cached Matrix image data, never account credentials.
type PersonAvatar struct {
	Avatar []byte `db:"avatar"`
	Hash   string `db:"avatar_hash"`
	Source string `db:"source"`
}

func (s *Store) PersonAvatar(person string) (PersonAvatar, error) {
	var p PersonAvatar
	err := s.App.DB().NewQuery(`SELECT avatar,avatar_hash,source FROM post_person_avatars WHERE person={:id}`).Bind(dbx.Params{"id": person}).One(&p)
	if errors.Is(err, sql.ErrNoRows) {
		return p, nil
	}
	return p, err
}
func (s *Store) SavePersonAvatar(person, source string, avatar []byte) error {
	hash := ""
	if len(avatar) > 0 {
		sum := sha256.Sum256(avatar)
		hash = hex.EncodeToString(sum[:])
	}
	_, err := s.App.DB().NewQuery(`INSERT INTO post_person_avatars(person,avatar,avatar_hash,source) VALUES({:id},{:image},{:hash},{:source}) ON CONFLICT(person) DO UPDATE SET avatar=excluded.avatar,avatar_hash=excluded.avatar_hash,source=excluded.source`).Bind(dbx.Params{"id": person, "image": avatar, "hash": hash, "source": source}).Execute()
	return err
}
