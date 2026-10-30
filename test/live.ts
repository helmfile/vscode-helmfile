import { loadRepository } from '../src/repositoryDownload';
async function main(): Promise<void> {
    try {
        const index = await loadRepository({ name: 'fluent-bit', url: 'https://fluent.github.io/helm-charts' }, '', undefined);
        const fluent = index.charts.get('fluent-bit') ?? [];
        console.log('HTTP index OK, fluent-bit versions:', fluent.slice(0, 3).map(e => e.version).join(', '));
    } catch (e) { console.log('HTTP error:', (e as Error).message); }
    try {
        const oci = await loadRepository({ name: 'spark-web-proxy', url: 'quay.io/okdp/charts', oci: true }, 'spark-web-proxy', undefined);
        const spark = oci.charts.get('spark-web-proxy') ?? [];
        console.log('OCI tags OK, spark-web-proxy versions:', spark.slice(0, 3).map(e => e.version).join(', '));
    } catch (e) { console.log('OCI error:', (e as Error).message); }
}
void main();
