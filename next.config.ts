import type { NextConfig } from 'next';

const repositoryName = process.env.GITHUB_REPOSITORY?.split('/')[1] ?? '';
const isGitHubPages = process.env.GITHUB_ACTIONS === 'true';
const isUserWebsite = repositoryName.endsWith('.github.io');

const basePath =
  isGitHubPages && !isUserWebsite ? `/${repositoryName}` : '';

const nextConfig: NextConfig = {
  output: 'export',
  trailingSlash: true,
  basePath,
  assetPrefix: basePath,
};

export default nextConfig;
