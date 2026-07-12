import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import { JWT } from 'google-auth-library';

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const API_KEY = process.env.TOKEN_BROKER_API_KEY;

if (!API_KEY || API_KEY.length < 24) {
  throw new Error(
    '请设置长度至少为 24 个字符的 TOKEN_BROKER_API_KEY'
  );
}

const app = Fastify({
  logger: true,

  // 防止用户上传异常大的 JSON。
  bodyLimit: 512 * 1024,
});

await app.register(multipart, {
  limits: {
    files: 1,
    fileSize: 512 * 1024,
  },
});

const GEMINI_SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/generative-language.retriever',
];

/**
 * 验证并使用服务账号 JSON 换取 Access Token。
 *
 * @param {Record<string, unknown>} serviceAccount
 */
async function exchangeToken(serviceAccount) {
  if (
    !serviceAccount ||
    typeof serviceAccount !== 'object' ||
    Array.isArray(serviceAccount)
  ) {
    throw new Error('请求内容必须是服务账号 JSON 对象');
  }

  if (serviceAccount.type !== 'service_account') {
    throw new Error('JSON type 必须是 service_account');
  }

  const requiredFields = [
    'project_id',
    'private_key_id',
    'private_key',
    'client_email',
  ];

  for (const field of requiredFields) {
    if (
      typeof serviceAccount[field] !== 'string' ||
      serviceAccount[field].length === 0
    ) {
      throw new Error(`服务账号 JSON 缺少字段：${field}`);
    }
  }

  /*
   * Google 官方库内部会完成：
   *
   * 1. 构造 JWT Header 和 Payload；
   * 2. 用 private_key 执行 RS256 签名；
   * 3. 把 JWT Assertion POST 到 Google OAuth；
   * 4. 取得 Access Token 和过期时间。
   */
  const client = new JWT({
    email: serviceAccount.client_email,
    key: serviceAccount.private_key,
    keyId: serviceAccount.private_key_id,
    scopes: GEMINI_SCOPES,
  });

  const credentials = await client.authorize();

  if (!credentials.access_token) {
    throw new Error('Google 响应中没有 access_token');
  }

  const now = Date.now();

  // 官方库通常会返回精确的毫秒级 expiry_date。
  const expiryDate =
    typeof credentials.expiry_date === 'number'
      ? credentials.expiry_date
      : now + 3600 * 1000;

  return {
    access_token: credentials.access_token,
    expires_in: Math.max(
      0,
      Math.floor((expiryDate - now) / 1000)
    ),
    token_type: credentials.token_type || 'Bearer',
    expires_at: new Date(expiryDate).toISOString(),
    project_id: serviceAccount.project_id,
    client_email: serviceAccount.client_email,
    scopes: GEMINI_SCOPES,
  };
}

/**
 * 使用 X-API-Key 保护这个服务。
 */
app.addHook('onRequest', async (request, reply) => {
  if (request.url === '/health') {
    return;
  }

  const suppliedKey = request.headers['x-api-key'];

  if (suppliedKey !== API_KEY) {
    return reply.code(401).send({
      error: 'unauthorized',
      message: 'X-API-Key 不正确',
    });
  }
});

app.get('/health', async () => {
  return {
    status: 'ok',
  };
});

/**
 * 方式一：直接发送服务账号 JSON。
 */
app.post('/v1/token/json', async (request, reply) => {
  try {
    return await exchangeToken(request.body);
  } catch (error) {
    request.log.warn({
      error: error instanceof Error
        ? error.message
        : String(error),
    });

    return reply.code(400).send({
      error: 'token_exchange_failed',
      message:
        error instanceof Error
          ? error.message
          : '未知错误',
    });
  }
});

/**
 * 方式二：multipart/form-data 上传 JSON 文件。
 *
 * 字段名必须是 file。
 */
app.post('/v1/token/file', async (request, reply) => {
  try {
    const file = await request.file();

    if (!file) {
      return reply.code(400).send({
        error: 'missing_file',
        message: '缺少名为 file 的上传文件',
      });
    }

    const buffer = await file.toBuffer();
    const text = buffer.toString('utf8');

    let serviceAccount;

    try {
      serviceAccount = JSON.parse(text);
    } catch {
      return reply.code(400).send({
        error: 'invalid_json',
        message: '上传的文件不是有效 JSON',
      });
    }

    return await exchangeToken(serviceAccount);
  } catch (error) {
    request.log.warn({
      error: error instanceof Error
        ? error.message
        : String(error),
    });

    return reply.code(400).send({
      error: 'token_exchange_failed',
      message:
        error instanceof Error
          ? error.message
          : '未知错误',
    });
  }
});

await app.listen({
  port: PORT,
  host: HOST,
});

console.log(`Token API 已启动：http://${HOST}:${PORT}`);
