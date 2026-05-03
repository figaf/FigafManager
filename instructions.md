####################################

0. SETUP/LOGIN

####################################

Install BTP CLI
Install CF CLI

##Set alias from installed location
doskey btp=C:\Figaf\windows-amd64\btp.exe $*
##Do the same for cf with it's coresponding path.

##Chose login method (Username/Password or SSO)
For now only SSO will be available.

#### BTP CLI ####

##Login
##1. SSO -> opens browser page
btp login --url https://cli.btp.cloud.sap --sso

##Construct cf api address
##Gets a json like below with the instances, searches for item with "environmentType": "cloudfoundry"
##Then gets value of coresponding field "landscapeLabel" and memorize it as 'landscape' because the address is always https://api.<landscape>.hana.ondemand.com

btp --format json list accounts/environment-instance

Sample response:
{
  "environmentInstances": [
    {
      "id": "C75C7B07-94A0-418E-99A8-A442839EB62E",
      "name": "17b44102trial",
      "brokerId": "985B006B-820E-40BF-AC53-AB3D2B86C294",
      "globalAccountGUID": "02f7feab-1bd1-4d42-9797-09e488811cfc",
      "subaccountGUID": "4643794f-2be0-4ce5-b7ee-79f5f1c28769",
      "tenantId": "4643794f-2be0-4ce5-b7ee-79f5f1c28769",
      "serviceId": "fa31b750-375f-4268-bee1-604811a89fd9",
      "planId": "267b5620-3011-4c48-8e56-8d103876275b",
      "operation": "provision",
      "parameters": "{\"instance_name\":\"17b44102trial\",\"archetype\":\"trial\",\"status\":\"ACTIVE\"}",
      "labels": "{\"API Endpoint\":\"https://api.cf.us10-001.hana.ondemand.com\",\"Org Name\":\"17b44102trial\",\"Org ID\":\"7f77f61b-8b1d-4ed9-aece-d4e7315d071a\",\"Org Memory Limit\":\"4,096MB\"}",
      "customLabels": {},
      "type": "Provision",
      "status": "Processed",
      "environmentType": "cloudfoundry",
      "landscapeLabel": "cf-us10-001",
      "platformId": "7f77f61b-8b1d-4ed9-aece-d4e7315d071a",
      "createdDate": "Apr 16, 2026, 8:11:49 AM",
      "modifiedDate": "Apr 16, 2026, 8:11:57 AM",
      "state": "OK",
      "stateMessage": "Environment instance created.",
      "serviceName": "cloudfoundry",
      "planName": "trial"
    }
  ]
}


#### CF CLI ####
##Login sso at the address with the <landscape> set previously.
cf login -a https://api.<landscape>.hana.ondemand.com --sso

Sample response:
API endpoint: https://api.cf.us10-001.hana.ondemand.com

Temporary Authentication Code ( Get one at https://<landscape>.hana.ondemand.com/passcode )

##The cf cli now awaits a code
##Open browser at address "https://login.<landscape>.hana.ondemand.com/passcode"
##Then user will copy the code. Have a textbox to paste the code. When clicking continue it will submit the code to the awaiting cf cli.

##Hopefully, we are now logged in in both BTP CLI and CF CLI

Now we should get more options on how to continue;
1. Deploy Figaf Tool SAP BTP, Cloud Foundry
2. Connect to Integration Suite

####################################

1. Deploy Figaf Tool SAP BTP, Cloud Foundry

####################################


##We now need to maintain the vars.yaml and set some variables inside.
These would be "General" configs. Both these and db options would be on the same page. 

Have the following fileds as textboxes: ID, Landscape Apps Domain, Location ID.
Try to fill each one like the following way:

         I. ID - The default ID in the yaml file

         II. Landscape Apps Domain

         ##Fetch the possible work CF domains
         cf domains

         Sample response:
         C:\Figaf>cf domains
         Getting domains in org 17b44102trial as sampleuser3@figaf.com...

         name                                     availability   internal   protocols
         apps.internal                            shared         true       http
         cert.cfapps.us10-001.hana.ondemand.com   shared                    http
         cfapps.us10-001.hana.ondemand.com        shared                    http

         ##We want to get the full name starting with cfapps
         Then In the vars.yaml add the cfapps URL to as LANDSCAPE_APPS_DOMAIN

         III. Location ID
         Fill with the response of the following command, if answer is shorter then 20 characters:

         powershell -NoProfile -Command "(Invoke-RestMethod -Uri 'https://hub.docker.com/v2/repositories/figaf/app/tags?name=btp&page_size=1&ordering=-last_updated').results[0].name"
      2403-btp




##Now for the postgresql-db service options.
##First run command marketplace to check available plans
cf marketplace -e postgresql-db

Sample response:
Getting service plan information for service offering postgresql-db in org 17b44102trial / space dev as sampleuser3@figaf.com...

broker: sm-backing-services-broker-postgresql-db-cf-us10-001-51b42369-07f7-443f-a1c3-ae6a75d005bb
   plan    description                         free or paid   costs
   trial   Trial PostgreSQL service offering   free

##Make a dropdown selection of the available plans

This page (with the settings above) would have a button to continue/deploy. 
By clicking it, it will execute the following:


##Check with the cf service figaf-db if a db with this name exists
##If not, with the selected <plan> string, run the command below to create db:
cf create-service postgresql-db <plan> figaf-db -c db.json

##Create XSUAA service.
cf create-service xsuaa application figaf-xsuaa -c xs-security.json

##For both figaf-db and figaf-xsuaa run every 10s untill from the parsed response, status:create succeeded. While still status:    create in progress, show a loading animation for the right one. Replace with Checkmark when done.
cf service figaf-db 
cf service figaf-xsuaa 

Sample response:
C:\Figaf-installer\Figaf-BTP-Deployment-btp-users>cf service figaf-db
Showing info of service figaf-db in org 17b44102trial / space dev as sampleuser3@figaf.com...

name:            figaf-db
guid:            a6cf4d83-6b8c-443c-9c65-4b0521f54c50
type:            managed
broker:          sm-backing-services-broker-postgresql-db-cf-us10-001-51b42369-07f7-443f-a1c3-ae6a75d005bb
offering:        postgresql-db
plan:            trial
tags:
offering tags:   relational, database
description:     PostgreSQL service on SAP BTP
documentation:
dashboard url:

Showing status of last operation:
   status:    create in progress
   message:   Operation create_instance is in progress for instance
              a6cf4d83-6b8c-443c-9c65-4b0521f54c50
   started:   2026-04-24T02:55:36Z
   updated:   2026-04-24T02:55:36Z

Showing bound apps:
   There are no bound apps for this service instance.

Showing sharing info:
   This service instance is not currently being shared.

Showing upgrade status:
   Upgrades are not supported by this broker.


##Assign role collections
    ##First run the command and make a list with users.
    btp list security/user

    Sample response
    username
    sampleuser3@figaf.com
    user2@figaf.com

    ##Then run the following command with the selected username(for example ampleuser3@figaf.com):
    btp assign security/role-collection PI_Administrator --to-user sampleuser3@figaf.com

    Sample response: Id: 5b0e43b3-c66e-464b-a6ea-6f5499782a58
    User Name: sampleuser3@figaf.com
    Given Name: Alex Daniel
    Family Name: Florea
    Role Collections:
    - PI_Administrator
    - AuthGroup.APIPortalRegistration
    - AuthGroup.API.ApplicationDeveloper
    - AuthGroup.API.Admin
    - APIPortal.Administrator
    - PI_Business_Expert
    - PI_Integration_Developer
    - Integration_Provisioner
    - Subaccount Administrator

    ✔ OK

##Deploy the applications 

    cf push --vars-file vars.yml