// Pith Post is an embedded PocketBase service for private Matrix agents.
package main

import (
	"errors"
	"log"
	"os"
	"path/filepath"
	"syscall"

	"github.com/minifish-org/pith-post/internal/admin"
	"github.com/minifish-org/pith-post/internal/agent"
	"github.com/minifish-org/pith-post/internal/matrix"
	"github.com/minifish-org/pith-post/internal/pith"
	"github.com/minifish-org/pith-post/internal/store"
	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/core"
)

func main() {
	// Linux/Unix deployment: private databases, session files, and WALs from their first creation.
	syscall.Umask(0077)
	app := pocketbase.NewWithConfig(pocketbase.Config{DefaultDataDir: "./data", DefaultDev: false})
	store.RegisterValidation(app)
	var manager *agent.Manager
	var factory matrix.Factory
	var lock *os.File
	app.OnBootstrap().BindFunc(func(e *core.BootstrapEvent) error {
		if err := os.MkdirAll(app.DataDir(), 0700); err != nil {
			return err
		}
		var err error
		lock, err = os.OpenFile(filepath.Join(app.DataDir(), "pith-post.lock"), os.O_CREATE|os.O_RDWR, 0600)
		if err != nil {
			return err
		}
		if err = syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
			return errors.New("data directory is already in use by another Pith Post process")
		}
		if err = e.Next(); err != nil {
			return err
		}
		if err = store.EnsureSchema(app); err != nil {
			return err
		}
		s, err := store.New(app, os.Getenv("PITH_POST_MASTER_KEY"))
		if err != nil {
			return err
		}
		if err = s.Init(); err != nil {
			return err
		}
		factory = matrix.Factory{Store: s}
		manager = agent.New(s, pith.Model{}, factory.Open)
		manager.Reset = factory.Reset
		return nil
	})
	app.OnServe().BindFunc(func(e *core.ServeEvent) error {
		// Bootstrap with the CLI instead of printing a secret installer token to logs.
		e.InstallerFunc = nil
		admin.Admin{Manager: manager, Matrix: factory}.Register(e)
		configs, err := manager.Store.Configs()
		if err != nil {
			return err
		}
		for _, config := range configs {
			if config.AutoStart {
				go func(id string) {
					if manager.Start(id) != nil {
						app.Logger().Warn("Agent autostart failed", "agent", id)
					}
				}(config.ID)
			}
		}
		return e.Next()
	})
	app.OnRecordDeleteRequest("agents").BindFunc(func(e *core.RecordRequestEvent) error {
		return manager.WithStopped(e.Record.Id, func() error {
			pending, err := manager.Store.Unsettled(e.Record.Id)
			if err != nil {
				return err
			}
			if pending {
				return e.BadRequestError("Resolve pending work before deleting the configuration", nil)
			}
			return e.Next()
		})
	})
	app.OnTerminate().BindFunc(func(e *core.TerminateEvent) error {
		if manager != nil {
			manager.Close()
		}
		err := e.Next()
		if lock != nil {
			_ = lock.Close()
		}
		return err
	})
	if err := app.Start(); err != nil {
		log.Print("Pith Post could not start. Check the master key, data-directory lock, configuration, and command usage.")
		os.Exit(1)
	}
}
