const github = require('@actions/github');
const core = require('@actions/core');

const octokit = new github.getOctokit(process.env.GITHUB_TOKEN || process.env.INPUT_GITHUB_TOKEN);
const { owner, repo } = github.context.repo;

async function main() {
  const prefix = core.getInput('prefix') || 'test';
  const debug = core.getInput('debug') || false;
  const exportDiff = core.getInput('export-change-log') === 'false' ? false : true;
  const compareTo = core.getInput('compare-to');

  console.log(
    "core.getInput('export-change-log');",
    core.getInput('export-change-log'),
    typeof core.getInput('export-change-log'),
  );
  function log(message) {
    if (!debug) return;
    console.log(`==== auto-tag action ====: ${message} \n`);
  }

  const { status, data: previousTags } = await octokit.rest.git.listMatchingRefs({
    owner,
    repo,
    ref: `tags/${prefix}`,
  });

  log(`request to listMatchingRefs, tags/${prefix}`);

  if (status !== 200) throw new Error('get previous tags failed, please retry!');

  log(`get previous tags ${JSON.stringify(previousTags)}`);

  const formattedTags = previousTags
    .map((payload) => ({
      tag: +payload.ref.replace(`refs/tags/${prefix}-`, ''),
      hash: payload.object.sha,
    }))
    .filter(({ tag }) => !Number.isNaN(tag))
    .sort((a, b) => a.tag - b.tag);

  log(`get formatted tags ${JSON.stringify(formattedTags)}`);

  const latestTag = formattedTags.length ? formattedTags[formattedTags.length - 1] : null;
  const latestVersion = latestTag ? latestTag.tag : 0;
  const currentTagVersion = latestVersion + 1;

  const prevTag = latestVersion ? `${prefix}-${latestVersion}` : '';
  const currentTag = `${prefix}-${currentTagVersion}`;

  const createRefStatus = await octokit.rest.git.createRef({
    owner,
    repo,
    ref: `refs/tags/${currentTag}`,
    sha: github.context.sha,
  });

  log(`createRefStatus ${createRefStatus.status} - ${JSON.stringify(createRefStatus.data)}`);

  const compareBase = compareTo || prevTag;
  if (compareBase && exportDiff) {
    log(`compareCommits refs/tags/${compareBase} - refs/tags/${currentTag}`);

    const { status: changelogStatus, data: changelog } = await octokit.rest.repos.compareCommits({
      owner,
      repo,
      base: compareBase,
      head: currentTag,
    });

    if (changelogStatus !== 200) {
      return core.warn(
        `fetch commits between refs/tags/${compareBase} - refs/tags/${currentTag} failed!`,
      );
    }

    log(`get changelog, ${JSON.stringify(changelog)}`);
    const commits = changelog.commits
      .map((commit, i) => {
        return `#${i + 1}) @${commit.author ? commit.author.login || '' : ''} ${commit.sha.slice(
          0,
          6,
        )} ${commit.commit.message}`;
      })
      .join('\n');
    core.setOutput('change-log', commits);
    core.setOutput('change-log-url', changelog.html_url);
    log(`change-log: ${commits}`);
    log(`change-log-url: ${changelog.html_url}`);
  }

  core.setOutput('prev-tag', prevTag);
  core.setOutput('current-tag', currentTag);

  log(`prev-tag: ${prevTag}`);
  log(`current-tag: ${currentTag}`);
}

process.on('unhandledPromiseRejection', (error) => {
  throw error;
});
process.on('unhandledRejection', (error) => {
  throw error;
});
main();
