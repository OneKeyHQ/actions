# fetch-kms-secrets

复合 action(composite action):通过 GitHub OIDC → STS 从火山引擎 KMS 拉取一份加密
secret,用混合加密 AES-256-GCM + RSA-OAEP-SHA256 解密,并把解出的 JSON 键值对写入
`$GITHUB_ENV`,供后续 step 使用。

下游仓库不存储任何长期有效的火山引擎 AK/SK,也不存储明文 secret —— 只持有 RSA 私钥
(建议放在组织级 GitHub Secret)。

```
GitHub OIDC → STS AssumeRoleWithOIDC → 临时 AK/SK → KMS GetSecretValue
            → 混合加密(AES-256-GCM + RSA-OAEP-SHA256)解密 → JSON 键值对 → $GITHUB_ENV
```

混合加密中的非对称包裹(RSA-OAEP)这一层是刻意设计的:它把"能读 KMS"(IAM/STS)和
"能解密并使用"(GitHub Secret)拆成两个相互独立的授权边界(控制面)。

## KMS secret 载荷契约

每个 KMS `SecretValue` 都是单个不透明的 base64 字符串。解密后得到一个扁平的 JSON
对象,其各个 key 会成为环境变量:

```json
{
  "CODACY_PROJECT_TOKEN": "<明文值>",
  "ANOTHER_KEY": "<明文值>"
}
```

该字符串由混合加密产生 —— AES-256-GCM 封装 JSON 明文,RSA-OAEP-SHA256 包裹一次性的
AES 密钥。由于 RSA 永远只包裹这 32 字节的密钥,JSON 载荷在实际使用中没有体积上限。
打包布局(base64 编码之前):`MAGIC('OK1') | wrappedKeyLen(2,BE) | wrappedKey |
iv(12) | tag(16) | ciphertext`。

加密时使用密钥对的公钥;对应私钥通过 `decrypt-private-key` 传入。打包格式由
[`scripts/envelope.js`](./scripts/envelope.js) 单点定义,**action 运行时与 ops 工具
共用同一实现**,不会漂移。

## ops 工具:`scripts/secret-tool.js`

一个零依赖的命令行工具,涵盖密钥生成、加密、解密三步:

```bash
# 1) 生成配对公私钥(默认 RSA-4096;私钥文件权限 600)
node scripts/secret-tool.js keygen ./keys
#   → ./keys/kms-decrypt-private.pem  (放入 GitHub Secret KMS_DECRYPT_PRIVATE_KEY)
#   → ./keys/kms-encrypt-public.pem   (用于加密)

# 2) 加密:把 { ENV_KEY: "value" } 的 JSON 封成 OK1 token,作为 KMS secret 的值上传
echo '{"CODACY_PROJECT_TOKEN":"<value>"}' \
  | node scripts/secret-tool.js encrypt ./keys/kms-encrypt-public.pem

# 3) 解密:本地离线核对 token(打印明文,切勿在 CI 日志里运行)
node scripts/secret-tool.js decrypt ./keys/kms-decrypt-private.pem token.txt
```

JSON / token 可由文件参数传入,省略时则读 stdin。密钥管理与 KMS 载荷约定详见
[Secret Manager 接入规范](https://onekeyhq.atlassian.net/wiki/spaces/ONEKEY/pages/1797652515)。

## 输入(Inputs)

| 名称                  | 必填 | 默认值           | 说明                                                          |
| --------------------- | ---- | ---------------- | ------------------------------------------------------------- |
| `volc-account-id`     | 是   | —                | 火山引擎账号 ID;用作 OIDC token 的 audience。                |
| `volc-role-trn`       | 是   | —                | 通过 OIDC 扮演的 IAM 角色 TRN。                              |
| `volc-kms-region`     | 是   | —                | KMS 区域,如 `cn-beijing`(`kms.<region>.volcengineapi.com`);无默认值。 |
| `secret-names`        | 是   | —                | 待拉取的 KMS secret 名称列表,每行一个。                      |
| `decrypt-private-key` | 是   | —                | PEM 编码的 RSA 私钥,用于解包 AES 密钥(RSA-OAEP-SHA256)。   |

## 输出(Outputs)

| 名称           | 说明                                                                |
| -------------- | ------------------------------------------------------------------- |
| `fetched-keys` | 写入 `$GITHUB_ENV` 的环境变量名 JSON 数组;**不暴露**对应的值。     |

## 用法

调用方 workflow **必须**声明 `permissions.id-token: write` —— 这是 GitHub 平台限制,
无法在复合 action 内部设置。

```yaml
jobs:
  example:
    runs-on: ubuntu-24.04
    permissions:
      id-token: write
      contents: read
    steps:
      - uses: actions/checkout@v4

      - name: Fetch KMS secrets
        uses: OneKeyHQ/actions/fetch-kms-secrets@<SHA>
        with:
          volc-account-id: ${{ vars.VOLC_ACCOUNT_ID }}
          volc-role-trn:   ${{ vars.VOLC_CODACY_ROLE_TRN }}
          volc-kms-region: ${{ vars.VOLC_KMS_REGION }}
          secret-names: |
            production-codacy-ci-secrets-json
          decrypt-private-key: ${{ secrets.KMS_DECRYPT_PRIVATE_KEY }}

      - name: Use a decrypted value
        run: echo "token starts with $(echo "$CODACY_PROJECT_TOKEN" | cut -c1-4)..."
```

最佳实践:把 `KMS_DECRYPT_PRIVATE_KEY` 存为**组织级** GitHub Secret,这样下游仓库无需
逐仓库配置即可继承;把账号 ID 和角色 TRN 存为组织级 GitHub **Variables**。

ops 的一次性配置(IAM 角色 + 锁定到 `oidc:iss/aud/sub` 的信任策略,关键角色另加
`oidc:job_workflow_ref`;`kms:GetSecretValue` 权限收敛到具体 secret;上传 KMS 信封;
创建组织级 secret / variables)详见
[Secret Manager 接入规范](https://onekeyhq.atlassian.net/wiki/spaces/ONEKEY/pages/1797652515)。

## 安全不变量

- 每个解密后的值在写入 `$GITHUB_ENV` 之前,都会先经过 `::add-mask::` 登记;多行值
  会逐行登记(`::add-mask::` 是按行生效的,否则第一行之后会泄漏)。
- STS 临时凭据在签发后立即 mask。
- 远端响应体与 RSA 密钥材料绝不回显到错误信息中。
- 私钥仅通过环境变量传入 node 脚本(`scripts/fetch-and-decrypt.js`)—— 绝不落盘。
- `volc-kms-region` 会按 `^[a-z0-9-]+$` 白名单校验后才拼进 KMS 主机名,防止被构造的
  区域值把请求(连同 STS 临时凭据)重定向到攻击者主机;请始终从可信 Variable 注入。

## 测试

零依赖,用 node 内置 test runner:

```bash
npm test            # 等价于 node --test scripts/*.test.js
```

覆盖信封往返(含 action 运行时与 CLI 共用核心的一致性)、GCM 防篡改、坏信封拒绝、
keygen 权限/拒绝覆盖、V4 签名结构、运行时 fail-fast 等。

## 失败模式

| 报错现象                                             | 可能原因                                                          |
| ---------------------------------------------------- | ----------------------------------------------------------------- |
| `GitHub OIDC env not present`                        | 调用方 workflow 缺少 `permissions.id-token: write`。              |
| `invalid volc-kms-region`                            | `volc-kms-region` 含非法字符(只允许小写字母/数字/连字符)。     |
| `STS AssumeRoleWithOIDC failed`                      | 信任策略 `sub` / `aud` / `job_workflow_ref` 不匹配,或未授权。    |
| `KMS GetSecretValue failed (SecretsManagerServiceNotOpen)` | 火山引擎账号尚未开通「密钥管理服务-凭据管理 / Secrets Manager」,需在控制台开通。 |
| `KMS GetSecretValue failed`                          | secret 在该区域不存在,或 IAM 缺少 `kms:GetSecretValue` 权限。    |
| `unrecognized envelope (expected magic 'OK1')`       | SecretValue 不是由 `scripts/secret-tool.js encrypt` 生成的。      |
| `RSA-OAEP-SHA256 unwrap … failed`                    | 私钥与加密所用公钥不匹配。                                        |
| `AES-256-GCM decrypt/auth failed`                    | 信封损坏,或是为另一把密钥加密的。                                |
