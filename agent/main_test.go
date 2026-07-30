package main

import (
	"io"
	"testing"
)

func TestCLIRejectsInlineToken(t *testing.T) {
	if _, err := parseCLI([]string{"--token", "sentinel"}, io.Discard); err == nil {
		t.Fatal("inline credential в --token принят; значение попало бы в список процессов")
	}
}

func TestCLIAcceptsTokenFile(t *testing.T) {
	const path = "/tmp/argus-agent-credential"
	cfg, err := parseCLI([]string{"--token-file", path}, io.Discard)
	if err != nil {
		t.Fatalf("документированный --token-file отвергнут: %v", err)
	}
	if cfg.tokenFile != path {
		t.Fatalf("путь к credential-файлу = %q, ожидался %q", cfg.tokenFile, path)
	}
}
