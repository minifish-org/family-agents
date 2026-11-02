GO ?= go

.PHONY: build test race vet run fmt smoke
build:
	CGO_ENABLED=0 $(GO) build -trimpath -tags goolm -o bin/pith-post ./cmd/pith-post

test:
	$(GO) test -tags goolm ./...

race:
	CGO_ENABLED=1 $(GO) test -race -tags goolm ./...

vet:
	$(GO) vet -tags goolm ./...

run: build
	./bin/pith-post serve --http=127.0.0.1:8090 --dir=./data

smoke: build
	python3 scripts/smoke.py ./bin/pith-post

fmt:
	gofmt -w cmd internal
