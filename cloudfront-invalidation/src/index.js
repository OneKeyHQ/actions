const core = require('@actions/core');
const AWS = require('aws-sdk');
const shortid = require('shortid');

// 从GitHub Actions输入中获取配置参数
const AWS_KEY_ID = core.getInput('aws_key_id', {
  required: true
});
const SECRET_ACCESS_KEY = core.getInput('aws_secret_access_key', {
  required: true
});
const DISTRIBUTION_ID = core.getInput('distribution_id', {
  required: true
});
const PATHS = core.getInput('paths', {
  required: true
}).split(',').map(path => path.trim().startsWith('/') ? path.trim() : `/${path.trim()}`);

// 配置AWS SDK
const cloudfront = new AWS.CloudFront({
  accessKeyId: AWS_KEY_ID,
  secretAccessKey: SECRET_ACCESS_KEY
});

// 创建缓存失效请求
function createInvalidation(distributionId, paths) {
  return new Promise((resolve, reject) => {
    const params = {
      DistributionId: distributionId,
      InvalidationBatch: {
        Paths: {
          Quantity: paths.length,
          Items: paths,
        },
        CallerReference: `invalidation-${shortid.generate()}`,
      },
    };

    cloudfront.createInvalidation(params, (err, data) => {
      if (err) {
        core.error(`Error creating invalidation: ${err}`);
        reject(err);
      } else {
        core.info(`Invalidation created successfully: ${JSON.stringify(data)}`);
        resolve(data);
      }
    });
  });
}

// 主函数
async function run() {
  try {
    core.info(`Creating invalidation for paths: ${PATHS.join(', ')}`);
    const result = await createInvalidation(DISTRIBUTION_ID, PATHS);
    core.setOutput('invalidation_id', result.Invalidation.Id);
    core.setOutput('invalidation_status', result.Invalidation.Status);
  } catch (err) {
    core.setFailed(err.message);
  }
}

run();
