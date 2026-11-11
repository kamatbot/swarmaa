CREATE TABLE watch_memos (
 tenant_id text NOT NULL, scope text NOT NULL, thread_id uuid NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
 memo_id uuid NOT NULL, sha256 text NOT NULL, byte_length integer NOT NULL CHECK (byte_length BETWEEN 1 AND 20971520),
 captured_at timestamptz NOT NULL, status text NOT NULL DEFAULT 'uploading' CHECK (status IN ('uploading','stored')),
 PRIMARY KEY (tenant_id, thread_id, memo_id)
);
CREATE TABLE watch_memo_chunks (
 tenant_id text NOT NULL, thread_id uuid NOT NULL, memo_id uuid NOT NULL, chunk_index integer NOT NULL CHECK (chunk_index BETWEEN 0 AND 159),
 data bytea NOT NULL CHECK (octet_length(data) BETWEEN 1 AND 131072),
 PRIMARY KEY (tenant_id, thread_id, memo_id, chunk_index),
 FOREIGN KEY (tenant_id, thread_id, memo_id) REFERENCES watch_memos(tenant_id,thread_id,memo_id) ON DELETE CASCADE
);
CREATE TABLE watch_transaction_requests (
 tenant_id text NOT NULL, scope text NOT NULL, thread_id uuid NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
 principal_id uuid NOT NULL REFERENCES principals(id), request_id uuid NOT NULL, request_hash text NOT NULL,
 origin text NOT NULL, expected_user_id text NOT NULL, account_id text, review_id text,
 PRIMARY KEY (tenant_id, principal_id, request_id), UNIQUE (tenant_id, principal_id, thread_id, review_id)
);
