/**
 * Entry của gateway: `npm run gateway` hoặc image `gateway/Dockerfile`.
 * - GATEWAY_UPSTREAMS: file upstreams.json (mặc định gateway/upstreams.json)
 * - GATEWAY_PUBLIC_KEY: khoá công khai kiểm giấy phép (mặc định khoá trong mã nguồn)
 * - HOST, PORT (mặc định 127.0.0.1:7332)
 */
import { loadUpstreams, startGateway } from "./gateway.ts"

const upstreams = loadUpstreams(process.env.GATEWAY_UPSTREAMS ?? "gateway/upstreams.json")
const g = await startGateway({ upstreams, publicKey: process.env.GATEWAY_PUBLIC_KEY, host: process.env.HOST, port: Number(process.env.PORT ?? 7332) })
console.log(`Hahaness gateway: ${g.url} (${Object.keys(upstreams).join(", ") || "no upstreams"})`)
