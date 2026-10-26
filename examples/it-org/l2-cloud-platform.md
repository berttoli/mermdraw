# L2 · Cloud platform

Drill-down of **Runtime, network & delivery** from the [L1 landscape](README.md): the GCP landing
zone, the paved road from commit to production, and how production is observed.

```mermaid
---
config:
  theme: base
  themeVariables:
    primaryColor: "#E9F7EF"
    primaryBorderColor: "#2F9E6B"
    primaryTextColor: "#123A28"
    lineColor: "#7FA894"
    clusterBkg: "#F4FBF7"
    clusterBorder: "#B6E2C9"
    edgeLabelBackground: "#FFFFFF"
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
---
flowchart LR
    subgraph delivery [Paved road · commit to production]
        direction TB
        repo@{ icon: "logos:github-icon", label: "GitHub monorepos", pos: "b", h: 40 }
        ci@{ icon: "logos:github-actions", label: "GitHub Actions CI", pos: "b", h: 40 }
        iac@{ icon: "logos:terraform-icon", label: "Terraform · landing zone", pos: "b", h: 40 }
        charts@{ icon: "logos:helm", label: "Helm charts", pos: "b", h: 40 }
        gitops@{ icon: "logos:argo-icon", label: "Argo CD · GitOps", pos: "b", h: 40 }
    end
    subgraph gcp [Google Cloud · prod folder]
        direction TB
        lb@{ icon: "logos:google-cloud", label: "Cloud Load Balancing + Armor", pos: "b", h: 40 }
        subgraph runtimes [Runtimes]
            gke@{ icon: "logos:kubernetes", label: "GKE Autopilot", pos: "b", h: 40 }
            run@{ icon: "logos:google-cloud-run", label: "Cloud Run · jobs & small APIs", pos: "b", h: 40 }
            fn@{ icon: "logos:google-cloud-functions", label: "Cloud Functions · glue", pos: "b", h: 40 }
        end
        secrets@{ icon: "logos:vault-icon", label: "Vault · secrets & PKI", pos: "b", h: 40 }
    end
    subgraph observe [Observability]
        direction TB
        otel@{ icon: "logos:opentelemetry-icon", label: "OpenTelemetry collector", pos: "b", h: 40 }
        prom@{ icon: "logos:prometheus", label: "Prometheus", pos: "b", h: 40 }
        grafana@{ icon: "logos:grafana", label: "Grafana dashboards", pos: "b", h: 40 }
        sentry@{ icon: "logos:sentry-icon", label: "Sentry · errors", pos: "b", h: 40 }
        pager@{ icon: "logos:pagerduty-icon", label: "PagerDuty · on-call", pos: "b", h: 40 }
    end
    repo --> ci
    ci -->|images| charts
    iac -->|plan / apply| gcp
    charts --> gitops
    gitops -->|sync| gke
    ci -->|deploy| run
    lb --> gke
    lb --> run
    gke -.->|traces, metrics| otel
    run -.-> otel
    fn -.-> otel
    gke --> secrets
    otel --> prom
    prom --> grafana
    gke -.->|exceptions| sentry
    prom -->|alerts| pager
    style delivery fill:#F5F7FF,stroke:#C3CBF3
    style observe fill:#FFF9F2,stroke:#F2C9A5
```
