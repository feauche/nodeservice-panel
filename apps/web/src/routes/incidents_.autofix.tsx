import { createFileRoute, redirect } from '@tanstack/react-router';
export const Route = createFileRoute('/incidents_/autofix')({beforeLoad:()=>{throw redirect({to:'/settings/incidents'});}});
