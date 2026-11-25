# Find Ledger records to verify

See [Find Ledger records to verify](inbox-api.md#find-ledger-records-to-verify) for the discovery command and verifier settings.

## Retain content from a range

From the repository root, create a private history directory on a filesystem that supports hard links. Pass the inclusive range, existing verifier settings and directory explicitly:

```sh
mkdir -m 700 history
node node/production/src/retain-range.mjs 1000 1099 evidence.json history
```

The command processes at most 32 candidate logs in up to 1,024 mined blocks, one at a time. Each verification uses the configured deadlines and 128 KiB response limit. Only authenticated raw CID bytes are saved; the CID (content identifier) names the file. Keep the directory and its parents under your control.

Exit 0 means every candidate returned by this RPC was saved or already matched a local file. Exit 2 prints per-position outcomes including gaps. Restore the content source and rerun the same command: it checks current chain evidence and hashes existing copies without fetching them again. Inspect a conflicting file before moving it aside; retention never replaces it. Exit 1 means the scan or setup failed. Narrow an oversized range; for a single block with over 32 returned records use discovery and single-record verification instead. A later scan may see different logs after a reorganization. A successful scan is not proof of full history.
