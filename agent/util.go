package main

import (
	"context"
	"os/exec"
	"time"
)

func lookPath(name string) (string, error) { return exec.LookPath(name) }

func contextWithTimeout(d time.Duration) (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), d)
}
