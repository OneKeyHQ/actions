const core = require('@actions/core');
const github = require('@actions/github');

async function getMergedPullRequest(sha) {
  const client = new github.getOctokit(process.env.GITHUB_TOKEN || process.env.INPUT_GITHUB_TOKEN);
  const { owner, repo } = github.context.repo;

  const resp = await client.rest.pulls.list({
    owner,
    repo,
    sort: 'updated',
    direction: 'desc',
    state: 'closed',
    per_page: 100,
  });

  const pull = resp.data.find((p) => p.merge_commit_sha === sha);
  if (!pull) {
    return null;
  }
  return pull;
}

async function main() {
  try {
    let pr =
      github.context.payload.pull_request || (await getMergedPullRequest(github.context.sha));
    console.log('sdfsdf 1111');
    if (!pr) {
      console.error(`commit=${github.context.sha} is NOT a pull request`);
      return;
    }
    console.log('sdfsdf 2222');

    // additions
    core.setOutput('additions', pr.additions);
    // deletions
    core.setOutput('deletions', pr.deletions);
    // changed_files
    core.setOutput('changed_files', pr.changed_files);
    // commits
    core.setOutput('commits', pr.commits);
    // assignee
    core.setOutput('assignee', pr.assignee);
    core.setOutput('assignees', pr.assignees);
    // number
    core.setOutput('number', pr.number);
    // title
    core.setOutput('title', pr.title);
    // body
    core.setOutput('body', pr.body);
    // created_at
    core.setOutput('created_at', pr.created_at);
    // updated_at
    core.setOutput('updated_at', pr.updated_at);
    // url
    core.setOutput('url', pr.html_url);
    // base_branch
    core.setOutput('base_branch', pr.base && pr.base.ref);
    // base_commit
    core.setOutput('base_commit', pr.base && pr.base.sha);
    // head_branch
    core.setOutput('head_branch', pr.head && pr.head.ref);
    // head_commit
    core.setOutput('head_commit', pr.head && pr.head.sha);
    // draft
    core.setOutput('draft', pr.draft);

    const { title, body, number, assignee } = pr;
    console.log({ title, body, number, assignee });
    let issue = '';
    let content_body = '';

    let is_content_body = false;
    let is_issue = false;

    let content_split = body.split(/[\n]/);
    content_split.forEach((element) => {
      if (element.indexOf('## Does this close any currently') != -1) {
        is_content_body = false;
      }
      if (element.indexOf('## Pull request type') != -1) {
        is_issue = false;
      }

      if (element && element.trim() != '' && element.trim() != '…') {
        if (is_content_body) content_body += element.trim() + ':-:';
        if (is_issue) {
          if (element.indexOf('If it fixes a bug or resolves a feature request') == -1) {
            issue += element.trim() + ':-:';
          }
        }
      }

      if (element.indexOf('## What does this implement/fix') != -1) {
        is_content_body = true;
      }
      if (element.indexOf('## Does this close any currently') != -1) {
        is_issue = true;
        is_content_body = false;
      }
      if (element.indexOf('## Pull request type') != -1) {
        is_issue = false;
      }
    });
    // content_body
    core.setOutput('content_body', content_body.replace(/[\r\n]/g, '').trim());
    // issue
    core.setOutput('issue', issue.replace(/[\r\n]/g, '').trim());
  } catch (error) {
    console.error(error);
  }
}

main().catch((err) => core.setFailed(err.message));
