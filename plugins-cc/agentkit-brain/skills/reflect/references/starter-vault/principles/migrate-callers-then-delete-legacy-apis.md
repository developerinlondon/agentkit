# Migrate Callers, Then Delete Legacy APIs

A replacement is not done while the old path still exists. Migrate every
caller, verify, then delete the legacy API in the same effort — a permanent
compatibility shim is a second implementation to maintain and a trap for the
next reader. Time-bounded fallbacks left running forever become attack surface.
