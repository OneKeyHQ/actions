const core = require('@actions/core');
const github = require('@actions/github')

async function main() {
    const pr = github.context.payload.pull_request;
    console.log("sdfsdf")
    if (!pr) {
        core.setFailed('Not a pull request')
        return
    }
    console.log("sdfsdf")

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
    core.setOutput('base_branch', pr.base.ref);
    // base_commit
    core.setOutput('base_commit', pr.base.sha);
    // head_branch
    core.setOutput('head_branch', pr.head.ref);
    // head_commit
    core.setOutput('head_commit', pr.head.sha);
    // draft
    core.setOutput('draft', pr.draft);


    try {
        let issue = ""
        let content_body = ""

        let body = pr.body
        let is_content_body = false
        let is_issue = false

        let content_split = body.split(/[\n]/)
        content_split.forEach(element => {
            if (element.indexOf('## Does this close any currently') != -1) {
                is_content_body = false
            }
            if (element.indexOf('## Pull request type') != -1) {
                is_issue = false
            }

            if (element && element.trim() != '' && element.trim() != '…') {
                if (is_content_body) content_body += element + "\n"
                if (is_issue) {
                    if (element.indexOf("If it fixes a bug or resolves a feature request") == -1) {
                        issue += element + "\n"
                    }
                }
            }

            if (element.indexOf('## What does this implement/fix') != -1) {
                is_content_body = true
            }
            if (element.indexOf('## Does this close any currently') != -1) {
                is_issue = true
                is_content_body = false
            }
            if (element.indexOf('## Pull request type') != -1) {
                is_issue = false
            }
        });
        // content_body
        core.setOutput('content_body', content_body.trim());
        // issue
        core.setOutput('issue', issue.trim());
    } catch (error) {
        console.error(error)
    }
}

main().catch(err => core.setFailed(err.message));