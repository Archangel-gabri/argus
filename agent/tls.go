package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/pem"
	"fmt"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"time"
)

// TLS с самоподписанным сертификатом.
//
// Публичного имени у машины нет, центру сертификации взяться неоткуда — поэтому доверие
// строится так же, как у SSH: при установке Argus запоминает отпечаток (TOFU) и потом
// принимает только его. Это защищает не «от всех», а ровно от того, от чего нужно:
// от прослушивания и подмены в локальной сети, где трафик иначе шёл бы открытым текстом.

const (
	certFile = "agent.crt"
	keyFile  = "agent.key"
)

// ensureCert возвращает пути к сертификату и ключу, создавая их при первом запуске.
func ensureCert(dir string) (string, string, error) {
	if dir == "" {
		return "", "", fmt.Errorf("не задан каталог для сертификата")
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", "", err
	}
	cp := filepath.Join(dir, certFile)
	kp := filepath.Join(dir, keyFile)
	if fileOK(cp) && fileOK(kp) {
		return cp, kp, nil
	}

	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return "", "", err
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return "", "", err
	}
	host, _ := os.Hostname()
	tpl := x509.Certificate{
		SerialNumber:          serial,
		Subject:               pkix.Name{CommonName: "argus-agent " + host},
		// Начало действия отодвинуто на двое суток назад — это не запас «на всякий случай».
		// Часы двух машин не обязаны совпадать: у двухзагрузочного ПК Windows пишет в
		// аппаратные часы МЕСТНОЕ время, Linux читает их как UTC, и система уезжает на целый
		// часовой пояс. Сертификат, выписанный «с этой секунды», на второй машине оказывается
		// выписанным в будущем, и TLS его отвергает — проверено на живом стенде: расхождение
		// в три часа роняло подключение с «certificate is not yet valid».
		NotBefore:             time.Now().Add(-48 * time.Hour),
		NotAfter:              time.Now().AddDate(10, 0, 0),
		// Сертификат самоподписанный и выступает СОБСТВЕННЫМ корнем доверия: Argus передаёт
		// его как доверенный CA и оставляет проверку TLS включённой. Без CA:TRUE и права
		// подписи OpenSSL откажется считать его якорем — «unable to verify the first certificate».
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment | x509.KeyUsageCertSign,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
		IsCA:                  true,
		DNSNames:              []string{"localhost", host},
		IPAddresses:           localIPs(),
	}
	der, err := x509.CreateCertificate(rand.Reader, &tpl, &tpl, &key.PublicKey, key)
	if err != nil {
		return "", "", err
	}

	if err := writeFile(cp, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0o644); err != nil {
		return "", "", err
	}
	kb, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		return "", "", err
	}
	// Ключ — только владельцу: он равнозначен возможности выдать себя за агента.
	if err := writeFile(kp, pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: kb}), 0o600); err != nil {
		return "", "", err
	}
	return cp, kp, nil
}

func fileOK(p string) bool {
	st, err := os.Stat(p)
	return err == nil && !st.IsDir() && st.Size() > 0
}

func writeFile(p string, b []byte, mode os.FileMode) error {
	if err := os.WriteFile(p, b, mode); err != nil {
		return err
	}
	return os.Chmod(p, mode)
}

// localIPs — адреса, по которым к агенту реально обращаются (в первую очередь Tailscale).
// Без них TLS-клиент, ходящий по IP, отвергнет сертификат ещё до проверки отпечатка.
func localIPs() []net.IP {
	out := []net.IP{net.ParseIP("127.0.0.1"), net.ParseIP("::1")}
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return out
	}
	for _, a := range addrs {
		if ipn, ok := a.(*net.IPNet); ok && !ipn.IP.IsLoopback() {
			out = append(out, ipn.IP)
		}
	}
	return out
}

// certFingerprint — SHA-256 от DER сертификата, нижним регистром без разделителей.
// Один формат на все стороны: Go печатает, Node сравнивает, Electron приводит из base64.
func certFingerprint(certPath string) (string, error) {
	b, err := os.ReadFile(certPath)
	if err != nil {
		return "", err
	}
	blk, _ := pem.Decode(b)
	if blk == nil {
		return "", fmt.Errorf("сертификат не разбирается: %s", certPath)
	}
	sum := sha256.Sum256(blk.Bytes)
	return hex.EncodeToString(sum[:]), nil
}
