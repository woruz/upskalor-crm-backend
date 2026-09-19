import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import type { Readable } from 'node:stream'

import type { StorageConfig } from '../types/config.js'

export const createStorageClient = (config: StorageConfig): S3Client =>
    new S3Client({
        region: config.region,
        ...(config.accessKeyId && config.secretAccessKey
            ? {
                  credentials: {
                      accessKeyId: config.accessKeyId,
                      secretAccessKey: config.secretAccessKey
                  }
              }
            : {})
    })

export const createUploadUrl = async (
    client: S3Client,
    config: StorageConfig,
    key: string,
    contentType: string,
    contentLength: number
): Promise<string> =>
    getSignedUrl(
        client,
        new PutObjectCommand({ Bucket: config.bucket, Key: key, ContentType: contentType, ContentLength: contentLength }),
        { expiresIn: config.presignExpiresIn }
    )

export const createDownloadUrl = async (client: S3Client, config: StorageConfig, key: string): Promise<string> =>
    getSignedUrl(client, new GetObjectCommand({ Bucket: config.bucket, Key: key }), { expiresIn: config.presignExpiresIn })

export const getObjectMetadata = async (client: S3Client, config: StorageConfig, key: string) =>
    client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: key }))

export const getObjectStream = async (
    client: S3Client,
    config: StorageConfig,
    key: string
): Promise<{ body: Readable; contentType: string | undefined; contentLength: number | undefined }> => {
    const result = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }))
    if (result.Body === undefined) {
        throw new Error('S3 object body is missing')
    }

    return {
        body: result.Body as Readable,
        contentType: result.ContentType,
        contentLength: result.ContentLength
    }
}

export const putObject = async (client: S3Client, config: StorageConfig, key: string, body: Readable | Buffer, contentType: string): Promise<void> => {
    await client.send(new PutObjectCommand({ Bucket: config.bucket, Key: key, Body: body, ContentType: contentType }))
}
