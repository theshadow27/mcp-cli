/**
 * @rule gql-query-paginates
 * @expect 0
 * @path packages/daemon/src/github/example.ts
 *
 * A first:100 query that selects pageInfo { hasNextPage endCursor } is clean.
 * Mutations and queries without first:/last: are also clean.
 */

declare function graphql(query: string, variables?: Record<string, unknown>): Promise<unknown>;

export async function getFiles(): Promise<void> {
  await graphql(`query($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        files(first: 100) {
          pageInfo { hasNextPage endCursor }
          nodes { path additions deletions }
        }
      }
    }
  }`);
}

export async function enableAutoMerge(): Promise<void> {
  await graphql(`mutation($input: EnablePullRequestAutoMergeInput!) {
    enablePullRequestAutoMerge(input: $input) {
      clientMutationId
    }
  }`);
}

export const plain = "first: 50 but not a template literal graphql query";
