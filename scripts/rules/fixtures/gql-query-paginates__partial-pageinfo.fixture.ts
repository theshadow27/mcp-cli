/**
 * @rule gql-query-paginates
 * @expect 1
 * @path packages/daemon/src/github/example.ts
 *
 * A query where the first first: connection has pageInfo but a deeper one does
 * not. The rule must inspect each connection individually, not clear a template
 * once any connection passes. files(first:100) passes; contexts(first:50) fires.
 * The intervening commits(last:1) is ignored — the rule only checks `first:`.
 */

declare function graphql(query: string, variables?: Record<string, unknown>): Promise<unknown>;

export async function getFilesAndChecks(): Promise<void> {
  await graphql(`query($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        files(first: 100) {
          pageInfo { hasNextPage endCursor }
          nodes { path additions deletions }
        }
        commits(last: 1) {
          nodes {
            commit {
              statusCheckRollup {
                contexts(first: 50) {
                  nodes { ... on CheckRun { name conclusion status } }
                }
              }
            }
          }
        }
      }
    }
  }`);
}
