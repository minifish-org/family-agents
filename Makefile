.PHONY: build test check dev
build:
	npm run build
	cargo build --locked --release --bins --manifest-path gateway/Cargo.toml
test:
	npm test
	cargo test --locked --manifest-path gateway/Cargo.toml
check:
	npm run check
	cargo clippy --locked --manifest-path gateway/Cargo.toml --all-targets -- -D warnings
dev:
	npm run dev
