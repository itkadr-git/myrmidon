package main

import (
	"bytes"
	"io"
	"testing"
)

// The frame header must be one that standard zstd decoders accept: magic,
// Frame_Header_Descriptor 0x00 (no single segment, no checksum, no dictionary)
// and a Window_Descriptor of Exponent 10 / Mantissa 0 = Window_Log 20 (1 MB).
func TestZstdFrameHeaderBytes(t *testing.T) {
	var buf bytes.Buffer
	zw := newZstdRawWriter(&buf)
	if _, err := zw.Write([]byte("hello")); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	b := buf.Bytes()
	if len(b) < 6 {
		t.Fatalf("frame too short: %d bytes", len(b))
	}
	if !bytes.Equal(b[:4], []byte{0x28, 0xb5, 0x2f, 0xfd}) {
		t.Fatalf("bad magic % x", b[:4])
	}
	if b[4] != 0x00 {
		t.Fatalf("Frame_Header_Descriptor = %#x, want 0x00", b[4])
	}
	if b[5] != 0x50 {
		t.Fatalf("Window_Descriptor = %#x, want 0x50", b[5])
	}
	if wl := 10 + int(b[5]>>3); wl != 20 {
		t.Fatalf("Window_Log = %d, want 20", wl)
	}
	// The first block header follows immediately and the data round-trips.
	out, err := io.ReadAll(newZstdRawReader(bytes.NewReader(b)))
	if err != nil || string(out) != "hello" {
		t.Fatalf("round trip: %q %v", out, err)
	}
}
