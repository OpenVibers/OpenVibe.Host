'use strict';
// An in-memory S3 client for tests ({ send(command) }, the @aws-sdk/client-s3 commands ovhost uses).
const assert = require('assert');
const { Readable } = require('stream');

/** An in-memory S3 that records every command it is sent. */
function mockS3({ pageSize = 1000 } = {}) {
    const objects = new Map();
    const uploads = new Map();
    const sent = [];
    let seq = 0;
    const s3 = {
        objects,
        sent,
        failPut: null, // (key) -> true to fail that PutObject/UploadPart
        async send(cmd) {
            const name = cmd.constructor.name;
            const i = cmd.input;
            sent.push({ name, input: { ...i, Body: i.Body ? `<${Buffer.byteLength(i.Body)} bytes>` : undefined } });
            switch (name) {
            case 'PutObjectCommand':
                if (s3.failPut && s3.failPut(i.Key)) throw new Error('503 SlowDown');
                assert.strictEqual(i.ContentLength, i.Body.length);
                objects.set(i.Key, Buffer.from(i.Body));
                return { ETag: '"put"' };
            case 'CreateMultipartUploadCommand': { const id = `up-${++seq}`; uploads.set(id, { key: i.Key, parts: new Map() }); return { UploadId: id }; }
            case 'UploadPartCommand':
                if (s3.failPut && s3.failPut(i.Key)) throw new Error('503 SlowDown');
                uploads.get(i.UploadId).parts.set(i.PartNumber, Buffer.from(i.Body));
                return { ETag: `"p${i.PartNumber}"` };
            case 'CompleteMultipartUploadCommand': {
                const u = uploads.get(i.UploadId);
                const nums = i.MultipartUpload.Parts.map((p) => p.PartNumber);
                assert.deepStrictEqual(nums, [...u.parts.keys()].sort((a, b) => a - b));
                objects.set(u.key, Buffer.concat(nums.map((n) => u.parts.get(n))));
                uploads.delete(i.UploadId);
                return {};
            }
            case 'AbortMultipartUploadCommand': uploads.delete(i.UploadId); return {};
            case 'ListObjectsV2Command': {
                const keys = [...objects.keys()].filter((k) => k.startsWith(i.Prefix || '')).sort();
                const start = i.ContinuationToken ? Number(i.ContinuationToken) : 0;
                const size = Math.min(pageSize, i.MaxKeys || 1000);
                const page = keys.slice(start, start + size);
                const more = start + size < keys.length;
                return { Contents: page.map((k) => ({ Key: k, Size: objects.get(k).length })), IsTruncated: more, NextContinuationToken: more ? String(start + size) : undefined };
            }
            case 'GetObjectCommand': {
                const o = objects.get(i.Key);
                if (!o) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
                const pieces = [];
                for (let k = 0; k < o.length; k += 1000) pieces.push(o.subarray(k, k + 1000));
                return { Body: Readable.from(pieces) };
            }
            case 'DeleteObjectCommand': objects.delete(i.Key); return {};
            default: throw new Error(`mock S3: unexpected ${name}`);
            }
        },
    };
    return s3;
}

module.exports = { mockS3 };
