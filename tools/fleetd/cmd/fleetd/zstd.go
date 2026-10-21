package main

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"io"
)

// RFC 8878 Zstandard magic number: 0xFD2FB528 (little-endian).
var zstdMagic = []byte{0x28, 0xb5, 0x2f, 0xfd}

const maxZstdBlockSize = 128 * 1024 // 128 KB

// zstdRawWriter wraps an io.Writer and writes uncompressed Zstandard frames
// using Raw_Blocks (RFC 8878 §3.1.1.2.1). Compliant with all standard zstd decoders.
type zstdRawWriter struct {
	w       io.Writer
	buf     []byte
	started bool
	closed  bool
}

func newZstdRawWriter(w io.Writer) *zstdRawWriter {
	return &zstdRawWriter{
		w:   w,
		buf: make([]byte, 0, maxZstdBlockSize),
	}
}

func (zw *zstdRawWriter) init() error {
	if zw.started {
		return nil
	}
	zw.started = true
	// Write magic number
	if _, err := zw.w.Write(zstdMagic); err != nil {
		return err
	}
	// Frame_Header_Descriptor: 0x00 (Single_Segment=0, FCS_Field_Size=0, Content_Checksum=0, Dict_ID=0)
	// Window_Descriptor: 0xA0 (Window_Log = 20 -> 1MB window)
	header := []byte{0x00, 0xa0}
	_, err := zw.w.Write(header)
	return err
}

func (zw *zstdRawWriter) Write(p []byte) (int, error) {
	if zw.closed {
		return 0, fmt.Errorf("zstd writer is closed")
	}
	if err := zw.init(); err != nil {
		return 0, err
	}
	total := len(p)
	for len(p) > 0 {
		avail := maxZstdBlockSize - len(zw.buf)
		if len(p) < avail {
			zw.buf = append(zw.buf, p...)
			break
		}
		zw.buf = append(zw.buf, p[:avail]...)
		p = p[avail:]
		if err := zw.flushBlock(false); err != nil {
			return 0, err
		}
	}
	return total, nil
}

func (zw *zstdRawWriter) flushBlock(last bool) error {
	if len(zw.buf) == 0 && !last {
		return nil
	}
	// Block_Header (3 bytes, little endian):
	// bit 0: Last_Block
	// bits 1-2: Block_Type (0 = Raw_Block)
	// bits 3-23: Block_Size (21 bits)
	lastBit := uint32(0)
	if last {
		lastBit = 1
	}
	blockSize := uint32(len(zw.buf))
	h := lastBit | (0 << 1) | (blockSize << 3)
	hdr := []byte{byte(h & 0xFF), byte((h >> 8) & 0xFF), byte((h >> 16) & 0xFF)}
	if _, err := zw.w.Write(hdr); err != nil {
		return err
	}
	if blockSize > 0 {
		if _, err := zw.w.Write(zw.buf); err != nil {
			return err
		}
	}
	zw.buf = zw.buf[:0]
	return nil
}

func (zw *zstdRawWriter) Close() error {
	if zw.closed {
		return nil
	}
	zw.closed = true
	if err := zw.init(); err != nil {
		return err
	}
	return zw.flushBlock(true)
}

// zstdRawReader wraps an io.Reader and reads Zstandard frames that use Raw_Blocks.
// If the stream does not begin with the zstd magic number, it falls back to raw read.
type zstdRawReader struct {
	r         io.Reader
	magicRead bool
	isZstd    bool
	remaining int64
	lastBlock bool
	headerBuf [4]byte
}

func newZstdRawReader(r io.Reader) io.Reader {
	return &zstdRawReader{r: r}
}

func (zr *zstdRawReader) Read(p []byte) (int, error) {
	if !zr.magicRead {
		zr.magicRead = true
		magic := make([]byte, 4)
		n, err := io.ReadFull(zr.r, magic)
		if err != nil {
			if n > 0 {
				return copy(p, magic[:n]), nil
			}
			return 0, err
		}
		if bytes.Equal(magic, zstdMagic) {
			zr.isZstd = true
			// Read Frame_Header_Descriptor (1 byte)
			desc := make([]byte, 1)
			if _, err := io.ReadFull(zr.r, desc); err != nil {
				return 0, err
			}
			singleSegment := (desc[0] & 0x04) != 0
			if !singleSegment {
				// Window_Descriptor (1 byte)
				win := make([]byte, 1)
				if _, err := io.ReadFull(zr.r, win); err != nil {
					return 0, err
				}
			}
		} else {
			// Not zstd: return the peeked 4 bytes followed by rest of r
			zr.isZstd = false
			zr.r = io.MultiReader(bytes.NewReader(magic), zr.r)
			return zr.r.Read(p)
		}
	}

	if !zr.isZstd {
		return zr.r.Read(p)
	}

	for {
		if zr.remaining > 0 {
			if int64(len(p)) > zr.remaining {
				p = p[:zr.remaining]
			}
			n, err := zr.r.Read(p)
			zr.remaining -= int64(n)
			if err == io.EOF {
				if zr.remaining > 0 {
					// The stream ended inside a block: a truncated frame is an error, never a clean end.
					return n, io.ErrUnexpectedEOF
				}
				err = nil
			}
			if n > 0 || err != nil {
				return n, err
			}
			continue
		}
		if zr.lastBlock {
			return 0, io.EOF
		}

		// Read 3-byte block header
		hdr := make([]byte, 3)
		if _, err := io.ReadFull(zr.r, hdr); err != nil {
			if err == io.EOF {
				// The last block was never seen: truncated frame.
				err = io.ErrUnexpectedEOF
			}
			return 0, err
		}
		h := uint32(hdr[0]) | (uint32(hdr[1]) << 8) | (uint32(hdr[2]) << 16)
		isLast := (h & 1) == 1
		blockType := (h >> 1) & 3
		blockSize := int64(h >> 3)
		zr.lastBlock = isLast

		if blockType != 0 {
			// Non-raw block encountered: for 1.6.6 snapshot/restore site-agents,
			// raw blocks are used. If compressed blocks appear, fail clearly.
			return 0, fmt.Errorf("zstd unsupported block type: %d (only raw blocks supported)", blockType)
		}

		zr.remaining = blockSize
	}
}

// Unused import guard
var _ = binary.LittleEndian
