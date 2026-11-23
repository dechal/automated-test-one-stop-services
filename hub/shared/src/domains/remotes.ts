export type RepoKind = 'tool' | 'project' | 'brain';
export interface RemoteEntry {
  name: string;
  url: string;
}
export interface RepoRemotes {
  id: string;
  label: string;
  kind: RepoKind;
  remotes: RemoteEntry[];
  error?: string;
}
export interface RemotesListResponse {
  repos: RepoRemotes[];
}
export interface SetRemoteUrlRequest {
  repo: string;
  name: string;
  url: string;
}
export interface AddRemoteRequest {
  repo: string;
  name: string;
  url: string;
}
export interface DeleteRemoteRequest {
  repo: string;
  name: string;
  confirmUrl: string;
}
