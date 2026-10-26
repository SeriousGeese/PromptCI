CC ?= cc
CFLAGS := -O2 -Wall
SRC = src/api/index.ts

.PHONY: lint fmt

build test: deps
	@echo "building with $(CC): $(CFLAGS)"

deps:
	@echo "deps"

lint:
	@echo "lint"

%.o: %.c
	$(CC) $(CFLAGS) -c $< -o $@
