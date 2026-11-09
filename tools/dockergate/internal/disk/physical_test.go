package disk

import (
	"context"
	"testing"
)

// Reflinks may be charged to two project quotas, but occupy the filesystem once.
func TestPhysicalPartitionDoesNotSumLogicalProjectCharges(t *testing.T) {
	deps := Deps{
		Statfs: fakeFs(Fs{BlockSize: 1024, Blocks: 1000, Free: 150, FreeRoot: 150}, nil),
		Run: func(_ context.Context, _ string, _ ...string) ([]byte, error) {
			return []byte(keyA + " 800 0 1000 00 [--------]\n" + keyB + " 800 0 1000 00 [--------]\n"), nil
		},
		ReadFile: func(_ string) ([]byte, error) { return []byte(keyA + ":1041\n" + keyB + ":1042\n"), nil },
		Now:      fixedNow,
	}
	r, err := Collect(context.Background(), "/bots", deps)
	if err != nil {
		t.Fatal(err)
	}
	if len(r.Projects) != 2 {
		t.Fatalf("projects: %+v", r.Projects)
	}
	logical := r.Projects[0].UsedBytes + r.Projects[1].UsedBytes
	if logical <= r.Partition.TotalBytes {
		t.Fatalf("expected logical charges above capacity, got %d", logical)
	}
	if r.Partition.UsedBytes != 850*1024 || r.Partition.UsedPercent != 85 {
		t.Fatalf("physical usage must come only from statfs, not %d logical bytes: %+v", logical, r.Partition)
	}
}
